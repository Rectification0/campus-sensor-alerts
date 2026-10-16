import { Type, type Static } from 'typebox';
import type { ErrorObject } from 'ajv';
import { createAjv } from '../common/ajv.js';
import type { FieldError } from '../common/errors.js';
import type { Reading } from '../engine/evaluator.js';

// PDF §3 / specs §4.1
export const ReadingBody = Type.Object(
  {
    sensorId: Type.String({ minLength: 1, maxLength: 64 }),
    type: Type.String({ minLength: 1, maxLength: 32 }),
    value: Type.Number(),
    timestamp: Type.String({ format: 'date-time' }), // RFC 3339: timezone required
  },
  { additionalProperties: false },
);
export type ReadingBody = Static<typeof ReadingBody>;

/** The batch route only checks the envelope; items are validated one by one (FR-2.2). */
export function batchBody(maxItems: number) {
  return Type.Array(Type.Unknown(), { minItems: 1, maxItems });
}

export function toFieldErrors(errors: ErrorObject[] | null | undefined): FieldError[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'is invalid',
  }));
}

const validateReading = createAjv({ coerce: false }).compile<ReadingBody>(ReadingBody);

export type ParseResult = { ok: true; reading: Reading } | { ok: false; errors: FieldError[] };

/** Validates one reading and converts it to the internal form (epoch-ms timestamp). */
export function parseReading(input: unknown): ParseResult {
  if (!validateReading(input)) return { ok: false, errors: toFieldErrors(validateReading.errors) };
  return { ok: true, reading: toReading(input) };
}

// Ajv's number type already rejects non-finite values such as 1e999 (parsed as Infinity).
export function toReading(body: ReadingBody): Reading {
  return {
    sensorId: body.sensorId,
    type: body.type,
    value: body.value,
    ts: Date.parse(body.timestamp),
  };
}
