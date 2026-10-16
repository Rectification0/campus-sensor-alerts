import { describe, expect, it } from 'vitest';
import { evaluate, type Reading } from '../../src/engine/evaluator.js';
import { WindowStore } from '../../src/engine/window.js';
import { RuleRegistry } from '../../src/rules/registry.js';
import type { Rule } from '../../src/rules/schemas.js';

const MIN = 60_000;

function makeRule(partial: Partial<Rule> & Pick<Rule, 'id'>): Rule {
  return {
    kind: 'THRESHOLD',
    type: 'temperature',
    operator: 'gt',
    threshold: 30,
    aggregation: null,
    windowSeconds: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function setup(...rules: Rule[]) {
  const registry = new RuleRegistry();
  registry.load(rules);
  const windows = new WindowStore();
  return (readings: Reading[]) => evaluate(readings, registry, windows);
}

const r = (sensorId: string, value: number, ts: number, type = 'temperature'): Reading => ({
  sensorId,
  type,
  value,
  ts,
});

describe('evaluate', () => {
  it('raises a THRESHOLD match (PDF example: 34.5 > 30)', () => {
    const run = setup(makeRule({ id: 'hot' }));
    const { alerts } = run([r('library-floor-2', 34.5, 0), r('library-floor-2', 22, MIN)]);
    expect(alerts).toEqual([
      {
        ruleId: 'hot',
        sensorId: 'library-floor-2',
        type: 'temperature',
        triggerValue: 34.5,
        lastValue: 34.5,
        windowStart: null,
        windowEnd: null,
        firstTriggeredAt: 0,
        lastTriggeredAt: 0,
        triggerCount: 1,
      },
    ]);
  });

  it('ignores readings of other types and disabled rules', () => {
    const run = setup(makeRule({ id: 'hot' }), makeRule({ id: 'off', enabled: false }));
    expect(run([r('s', 99, 0, 'humidity')]).alerts).toEqual([]);
    expect(run([r('s', 99, 0)]).alerts.map((a) => a.ruleId)).toEqual(['hot']);
  });

  it('coalesces repeated matches per (rule, sensor) and evaluates in timestamp order', () => {
    const run = setup(makeRule({ id: 'hot' }));
    const { alerts } = run([
      r('a', 35, 2 * MIN),
      r('a', 31, MIN),
      r('b', 40, MIN),
      r('a', 33, 3 * MIN),
    ]);
    const a = alerts.find((x) => x.sensorId === 'a')!;
    expect(a).toMatchObject({
      triggerValue: 31,
      lastValue: 33,
      firstTriggeredAt: MIN,
      lastTriggeredAt: 3 * MIN,
      triggerCount: 3,
    });
    expect(alerts.find((x) => x.sensorId === 'b')!.triggerCount).toBe(1);
  });

  it('raises a WINDOW match on the 10-minute average (PDF example)', () => {
    const run = setup(
      makeRule({
        id: 'avg10',
        kind: 'WINDOW',
        aggregation: 'avg',
        windowSeconds: 600,
        threshold: 28,
      }),
    );
    // avg(27, 28) = 27.5 -> no match; avg(27, 28, 30.2) = 28.4 -> match
    expect(run([r('lab', 27, 0), r('lab', 28, MIN)]).alerts).toEqual([]);
    const { alerts } = run([r('lab', 30.2, 2 * MIN)]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ windowStart: 0, windowEnd: 2 * MIN });
    expect(alerts[0]!.triggerValue).toBeCloseTo(28.4, 9);
    // 11 minutes later only the most recent readings remain in the window.
    expect(run([r('lab', 20, 13 * MIN)]).alerts).toEqual([]);
  });

  it('supports min and max aggregations', () => {
    const run = setup(
      makeRule({
        id: 'min',
        kind: 'WINDOW',
        aggregation: 'min',
        windowSeconds: 60,
        operator: 'gte',
        threshold: 25,
      }),
      makeRule({
        id: 'max',
        kind: 'WINDOW',
        aggregation: 'max',
        windowSeconds: 60,
        operator: 'gte',
        threshold: 40,
      }),
    );
    const { alerts } = run([r('s', 26, 0), r('s', 41, 1000)]);
    expect(alerts.map((a) => [a.ruleId, a.triggerCount])).toEqual([
      ['min', 2],
      ['max', 1],
    ]);
  });

  it('counts late readings but still applies THRESHOLD rules to them', () => {
    const run = setup(
      makeRule({ id: 'hot' }),
      makeRule({ id: 'avg', kind: 'WINDOW', aggregation: 'avg', windowSeconds: 600 }),
    );
    run([r('s', 20, 5 * MIN)]);
    const { alerts, lateReadings } = run([r('s', 50, MIN)]);
    expect(lateReadings).toBe(1);
    expect(alerts.map((a) => a.ruleId)).toEqual(['hot']);
  });
});
