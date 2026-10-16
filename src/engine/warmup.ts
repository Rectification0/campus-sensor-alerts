// Rebuilds WINDOW rule state from stored readings, without emitting alerts (FR-6.3, design §7.5).

import type pg from 'pg';
import type { Rule } from '../rules/schemas.js';
import { SlidingWindow } from './window.js';

interface HistoryRow {
  sensor_id: string;
  value: number;
  recorded_at: Date;
}

/**
 * Builds fresh windows for the given WINDOW rules. For each sensor the history is anchored
 * at that sensor's newest stored reading (event time), not at wall-clock now. Rules sharing
 * a metric type share one query covering the longest of their windows.
 */
export async function buildWindows(
  db: pg.Pool,
  rules: readonly Rule[],
  now = Date.now(),
): Promise<Map<string, Map<string, SlidingWindow>>> {
  const result = new Map<string, Map<string, SlidingWindow>>();
  const byType = new Map<string, Rule[]>();
  for (const rule of rules) {
    if (rule.kind !== 'WINDOW') continue;
    result.set(rule.id, new Map());
    byType.set(rule.type, [...(byType.get(rule.type) ?? []), rule]);
  }

  for (const [type, typeRules] of byType) {
    const maxSeconds = Math.max(...typeRules.map((r) => r.windowSeconds!));
    const { rows } = await db.query<HistoryRow>(
      `SELECT r.sensor_id, r.value, r.recorded_at
       FROM readings r
       JOIN (SELECT sensor_id, max(recorded_at) AS latest
             FROM readings WHERE type = $1 GROUP BY sensor_id) l USING (sensor_id)
       WHERE r.type = $1 AND r.recorded_at > l.latest - make_interval(secs => $2)
       ORDER BY r.sensor_id, r.recorded_at, r.id`,
      [type, maxSeconds],
    );
    for (const rule of typeRules) {
      const sensors = result.get(rule.id)!;
      for (const row of rows) {
        let window = sensors.get(row.sensor_id);
        if (!window) {
          window = new SlidingWindow(rule.windowSeconds! * 1000);
          sensors.set(row.sensor_id, window);
        }
        // Each window evicts everything older than its own length on add.
        window.add(row.recorded_at.getTime(), row.value, now);
      }
    }
  }
  return result;
}
