import { describe, expect, it } from 'vitest';
import {
  baselineFor,
  ReadingGenerator,
  seededRandom,
  SensorSeries,
  sensorId,
} from '../../simulator/patterns.js';
import { percentile, Stats } from '../../simulator/sender.js';
import { parseReading } from '../../src/ingest/schemas.js';

describe('SensorSeries', () => {
  it('normal: random walk stays within base ± spread', () => {
    const s = new SensorSeries('temperature', 'normal', seededRandom(1));
    const values = Array.from({ length: 10_000 }, () => s.next(0));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(19);
    expect(Math.max(...values)).toBeLessThanOrEqual(25);
  });

  it('spike: ~2% of values land 3-4 spreads above base', () => {
    const s = new SensorSeries('temperature', 'spike', seededRandom(2));
    const values = Array.from({ length: 10_000 }, () => s.next(0));
    const spikes = values.filter((v) => v > 25);
    expect(spikes.length).toBeGreaterThan(100);
    expect(spikes.length).toBeLessThan(300);
    for (const v of spikes) {
      expect(v).toBeGreaterThanOrEqual(31);
      expect(v).toBeLessThanOrEqual(34);
    }
  });

  it('drift: rises one spread per minute', () => {
    const s = new SensorSeries('co2', 'drift', seededRandom(3));
    const { base, spread } = baselineFor('co2');
    const atStart = s.next(0);
    const afterTenMinutes = s.next(600);
    expect(atStart).toBeLessThanOrEqual(base + spread);
    expect(afterTenMinutes).toBeGreaterThan(base + 9 * spread);
  });

  it('is deterministic for a given seed', () => {
    const a = new SensorSeries('humidity', 'spike', seededRandom(42));
    const b = new SensorSeries('humidity', 'spike', seededRandom(42));
    for (let i = 0; i < 100; i++) expect(a.next(i)).toBe(b.next(i));
  });
});

describe('ReadingGenerator', () => {
  it('produces readings the service accepts, round-robin over sensors and types', () => {
    const gen = new ReadingGenerator({
      sensors: 3,
      types: ['temperature', 'co2'],
      pattern: 'normal',
      random: seededRandom(7),
    });
    expect(gen.seriesCount).toBe(6);
    const readings = gen.take(6, Date.parse('2026-10-12T10:30:00Z'));
    expect(readings.map((r) => `${r.sensorId}/${r.type}`)).toEqual([
      'library-floor-1/temperature',
      'library-floor-1/co2',
      'hostel-a-floor-1/temperature',
      'hostel-a-floor-1/co2',
      'hostel-b-floor-1/temperature',
      'hostel-b-floor-1/co2',
    ]);
    for (const r of readings) {
      expect(r.timestamp).toBe('2026-10-12T10:30:00.000Z');
      expect(parseReading(r).ok).toBe(true);
    }
  });

  it('names sensors {building}-floor-{n}', () => {
    expect(sensorId(0)).toBe('library-floor-1');
    expect(sensorId(7)).toBe('library-floor-2');
    expect(sensorId(10)).toBe('lab-floor-2');
  });
});

describe('Stats', () => {
  it('computes nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([], 50)).toBe(0);
  });

  it('summarises statuses, counts and latency', () => {
    const stats = new Stats();
    stats.record({ readings: 100, status: 202, accepted: 98, rejected: 2, latencyMs: 10 });
    stats.record({ readings: 100, status: 503, accepted: 0, rejected: 100, latencyMs: 30 });
    stats.record({ readings: 1, status: null, accepted: 0, rejected: 1, latencyMs: 20 });
    const s = stats.summary(500);
    expect(s).toMatchObject({
      requests: 3,
      readingsSent: 201,
      accepted: 98,
      rejected: 103,
      statusCounts: { '202': 1, '503': 1, error: 1 },
      errors: 1,
      readingsPerSecond: 196,
      latencyMs: { min: 10, p50: 20, max: 30, mean: 20 },
    });
  });
});
