import { describe, expect, it } from 'vitest';
import { IngestBuffer, type PendingRequest } from '../../src/ingest/buffer.js';

const req = (n: number, tag = ''): PendingRequest => ({
  readings: Array.from({ length: n }, (_, i) => ({ sensorId: tag, type: 't', value: i, ts: i })),
  resolve: () => {},
  reject: () => {},
});

describe('IngestBuffer', () => {
  it('accepts requests up to capacity, all-or-nothing', () => {
    const buf = new IngestBuffer(10);
    expect(buf.push(req(6))).toBe(true);
    expect(buf.push(req(5))).toBe(false);
    expect(buf.depth).toBe(6);
    expect(buf.push(req(4))).toBe(true);
    expect(buf.depth).toBe(10);
  });

  it('drains whole requests in FIFO order without exceeding the limit', () => {
    const buf = new IngestBuffer(100);
    buf.push(req(3, 'a'));
    buf.push(req(3, 'b'));
    buf.push(req(3, 'c'));
    const first = buf.drain(7);
    expect(first.map((r) => r.readings[0]!.sensorId)).toEqual(['a', 'b']);
    expect(buf.depth).toBe(3);
    expect(buf.drain(7).map((r) => r.readings[0]!.sensorId)).toEqual(['c']);
    expect(buf.depth).toBe(0);
    expect(buf.drain(7)).toEqual([]);
  });

  it('always drains at least one request, even if larger than the limit', () => {
    const buf = new IngestBuffer(100);
    buf.push(req(50));
    buf.push(req(1));
    expect(buf.drain(10).map((r) => r.readings.length)).toEqual([50]);
    expect(buf.depth).toBe(1);
  });

  it('frees capacity as requests are drained', () => {
    const buf = new IngestBuffer(5);
    buf.push(req(5));
    expect(buf.push(req(1))).toBe(false);
    buf.drain(5);
    expect(buf.push(req(5))).toBe(true);
  });
});
