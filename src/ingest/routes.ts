import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FieldError } from '../common/errors.js';
import type { Reading } from '../engine/evaluator.js';
import type { IngestPipeline } from './pipeline.js';
import { batchBody, parseReading, ReadingBody, toReading } from './schemas.js';

export interface IngestRoutesOptions {
  pipeline: IngestPipeline;
  batchMaxItems: number;
}

// Both routes reply 202 only after the readings are committed (FR-1.1, FR-2.2).
export const ingestRoutes: FastifyPluginAsyncTypebox<IngestRoutesOptions> = async (
  app,
  { pipeline, batchMaxItems },
) => {
  app.post('/readings', { schema: { body: ReadingBody } }, async (req, reply) => {
    await pipeline.submit([toReading(req.body)]);
    return reply.status(202).send({ accepted: 1 });
  });

  app.post(
    '/readings/batch',
    { schema: { body: batchBody(batchMaxItems) } },
    async (req, reply) => {
      const valid: Reading[] = [];
      const rejected: { index: number; errors: FieldError[] }[] = [];
      req.body.forEach((item, index) => {
        const parsed = parseReading(item);
        if (parsed.ok) valid.push(parsed.reading);
        else rejected.push({ index, errors: parsed.errors });
      });

      if (!valid.length) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'No valid readings in batch',
          accepted: 0,
          rejected,
        });
      }
      await pipeline.submit(valid);
      return reply.status(202).send({ accepted: valid.length, rejected });
    },
  );
};
