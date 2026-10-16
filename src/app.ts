import { STATUS_CODES } from 'node:http';
import Fastify, { LogController, type FastifyError } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from './common/errors.js';
import type { Config } from './config.js';
import type { RuleEngine } from './engine/engine.js';
import { rulesRoutes } from './rules/routes.js';

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
    ajv: { customOptions: { allErrors: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

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
    if (statusCode >= 500) {
      request.log.error({ err }, 'request failed');
      return reply
        .status(statusCode)
        .send({ statusCode, error: STATUS_CODES[statusCode], message: STATUS_CODES[statusCode] });
    }
    return reply.status(statusCode).send({
      statusCode,
      error: STATUS_CODES[statusCode],
      message: err.message,
      ...(err instanceof HttpError && err.errors ? { errors: err.errors } : {}),
    });
  });

  app.register(rulesRoutes, { prefix: '/api/v1', pool, engine });

  return app;
}

export type App = ReturnType<typeof buildApp>;
