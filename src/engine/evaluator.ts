// Evaluates a batch of readings against enabled rules (FR-5, FR-6) and coalesces
// matches per (rule, sensor) into alert upserts (FR-7.2, design §7.6).

import type { RuleRegistry } from '../rules/registry.js';
import { compare } from './operators.js';
import { aggregate, type WindowStore } from './window.js';

export interface Reading {
  sensorId: string;
  type: string;
  value: number;
  ts: number; // epoch ms
}

export interface AlertUpsert {
  ruleId: string;
  sensorId: string;
  type: string;
  triggerValue: number;
  lastValue: number;
  windowStart: number | null;
  windowEnd: number | null;
  firstTriggeredAt: number;
  lastTriggeredAt: number;
  triggerCount: number;
}

export interface EvaluationResult {
  alerts: AlertUpsert[];
  /** Readings skipped by at least one WINDOW rule for being out of order. */
  lateReadings: number;
}

export function evaluate(
  readings: readonly Reading[],
  registry: RuleRegistry,
  windows: WindowStore,
  now = Date.now(),
): EvaluationResult {
  // Stable sort: equal timestamps keep arrival order (FR-2.4).
  const ordered = [...readings].sort((a, b) => a.ts - b.ts);
  const matches = new Map<string, AlertUpsert>();
  let lateReadings = 0;

  const record = (
    ruleId: string,
    r: Reading,
    value: number,
    windowStart: number | null,
    windowEnd: number | null,
  ) => {
    const key = `${ruleId}|${r.sensorId}`;
    const existing = matches.get(key);
    if (existing) {
      existing.lastValue = value;
      existing.lastTriggeredAt = r.ts;
      existing.triggerCount++;
    } else {
      matches.set(key, {
        ruleId,
        sensorId: r.sensorId,
        type: r.type,
        triggerValue: value,
        lastValue: value,
        windowStart,
        windowEnd,
        firstTriggeredAt: r.ts,
        lastTriggeredAt: r.ts,
        triggerCount: 1,
      });
    }
  };

  for (const r of ordered) {
    let late = false;
    for (const rule of registry.forType(r.type)) {
      if (rule.kind === 'THRESHOLD') {
        if (compare(rule.operator, r.value, rule.threshold))
          record(rule.id, r, r.value, null, null);
        continue;
      }
      const snap = windows.add(rule.id, rule.windowSeconds!, r.sensorId, r.ts, r.value, now);
      if (!snap) {
        late = true;
        continue;
      }
      const value = aggregate(snap, rule.aggregation!);
      if (compare(rule.operator, value, rule.threshold)) {
        record(rule.id, r, value, snap.windowStart, snap.windowEnd);
      }
    }
    if (late) lateReadings++;
  }

  return { alerts: [...matches.values()], lateReadings };
}
