import { STATUS_CODES } from 'node:http';
import Fastify, { LogController, type FastifyError } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { alertsRoutes } from './alerts/routes.js';
import { createAjv } from './common/ajv.js';
import { HttpError } from './common/errors.js';
import type { Config } from './config.js';
import type { RuleEngine } from './engine/engine.js';
import { IngestPipeline } from './ingest/pipeline.js';
import { ingestRoutes } from './ingest/routes.js';
import { rulesRoutes } from './rules/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    pipeline: IngestPipeline;
  }
}

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  engine: RuleEngine;
}

export function buildApp({ config, pool, engine }: AppDeps) {
  const app = Fastify({
    logger: { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: !config.requestLogging }),
    bodyLimit: config.bodyLimitBytes,
  }).withTypeProvider<TypeBoxTypeProvider>();

  const strictAjv = createAjv({ coerce: false });
  const coercingAjv = createAjv({ coerce: true });
  app.setValidatorCompiler(({ schema, httpPart }) =>
    (httpPart === 'body' ? strictAjv : coercingAjv).compile(schema),
  );

  // Error shape (specs §8): Fastify's standard body, plus per-field errors on validation failures.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: err.message,
        errors: err.validation.map((v) => ({
          path: v.instancePath || '/',
          message: v.message ?? 'is invalid',
        })),
      });
    }
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500 && !(err instanceof HttpError)) {
      request.log.error({ err }, 'request failed');
      return reply
        .status(statusCode)
        .send({ statusCode, error: STATUS_CODES[statusCode], message: STATUS_CODES[statusCode] });
    }
    if (err instanceof HttpError && err.headers) reply.headers(err.headers);
    return reply.status(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode],
      message: err.message,
      ...(err instanceof HttpError && err.errors ? { errors: err.errors } : {}),
    });
  });

  const pipeline = new IngestPipeline({
    pool,
    engine,
    log: app.log,
    bufferCapacity: config.bufferCapacity,
    flushIntervalMs: config.flushIntervalMs,
    flushMaxRows: config.flushMaxRows,
    flushConcurrency: config.flushConcurrency,
    commitRetryBudgetMs: config.commitRetryBudgetMs,
  });
  app.decorate('pipeline', pipeline);
  // Runs after the server stops accepting and in-flight requests finish (NFR-4).
  app.addHook('onClose', () => pipeline.close());

  app.register(ingestRoutes, { prefix: '/api/v1', pipeline, batchMaxItems: config.batchMaxItems });
  app.register(rulesRoutes, { prefix: '/api/v1', pool, engine });
  app.register(alertsRoutes, { prefix: '/api/v1', pool });

  return app;
}

export type App = ReturnType<typeof buildApp>;
