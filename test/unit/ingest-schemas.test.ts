import { describe, expect, it } from 'vitest';
import { parseReading } from '../../src/ingest/schemas.js';

const valid = {
  sensorId: 'library-floor-2',
  type: 'temperature',
  value: 34.5,
  timestamp: '2026-10-12T10:30:00Z',
};

describe('parseReading (specs §4.1)', () => {
  it('accepts the PDF example and converts the timestamp to epoch ms', () => {
    expect(parseReading(valid)).toEqual({
      ok: true,
      reading: {
        sensorId: 'library-floor-2',
        type: 'temperature',
        value: 34.5,
        ts: Date.parse('2026-10-12T10:30:00Z'),
      },
    });
  });

  it('accepts timezone offsets', () => {
    const r = parseReading({ ...valid, timestamp: '2026-10-12T16:00:00+05:30' });
    expect(r.ok && r.reading.ts).toBe(Date.parse('2026-10-12T10:30:00Z'));
  });

  it.each([
    ['missing value', { ...valid, value: undefined }, '/'],
    ['string value (no coercion)', { ...valid, value: '34.5' }, '/value'],
    ['empty sensorId', { ...valid, sensorId: '' }, '/sensorId'],
    ['sensorId too long', { ...valid, sensorId: 'x'.repeat(65) }, '/sensorId'],
    ['timestamp without timezone', { ...valid, timestamp: '2026-10-12T10:30:00' }, '/timestamp'],
    ['impossible date', { ...valid, timestamp: '2026-02-30T10:30:00Z' }, '/timestamp'],
    ['unknown field', { ...valid, unit: 'C' }, '/'],
    ['infinite value', { ...valid, value: Infinity }, '/value'],
  ])('rejects %s', (_name, input, path) => {
    const r = parseReading(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toContain(path);
  });

  it('rejects non-objects', () => {
    expect(parseReading(42).ok).toBe(false);
    expect(parseReading(null).ok).toBe(false);
  });
});
