import type pg from 'pg';
import { HttpError, notFound } from '../common/errors.js';
import type { Alert, AlertStatus } from './schemas.js';

interface AlertRow {
  id: string;
  rule_id: string;
  sensor_id: string;
  type: string;
  status: AlertStatus;
  trigger_value: number;
  last_value: number;
  window_start: Date | null;
  window_end: Date | null;
  first_triggered_at: Date;
  last_triggered_at: Date;
  trigger_count: number;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    ruleId: row.rule_id,
    sensorId: row.sensor_id,
    type: row.type,
    status: row.status,
    triggerValue: row.trigger_value,
    lastValue: row.last_value,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    firstTriggeredAt: row.first_triggered_at,
    lastTriggeredAt: row.last_triggered_at,
    triggerCount: row.trigger_count,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Newest first. UUIDv7 ids are time-ordered, so the cursor is the last id returned (FR-8.1). */
export async function listAlerts(
  db: pg.Pool,
  { limit, cursor }: { limit: number; cursor?: string | undefined },
): Promise<{ items: Alert[]; nextCursor: string | null }> {
  const { rows } = await db.query<AlertRow>(
    `SELECT * FROM alerts WHERE ($1::uuid IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`,
    [cursor ?? null, limit + 1],
  );
  const items = rows.slice(0, limit).map(toAlert);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
}

export async function getAlert(db: pg.Pool, id: string): Promise<Alert | undefined> {
  const { rows } = await db.query<AlertRow>('SELECT * FROM alerts WHERE id = $1', [id]);
  return rows[0] && toAlert(rows[0]);
}

const transitions = {
  acknowledge: {
    target: 'ACKNOWLEDGED',
    sql: `UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'OPEN' RETURNING *`,
  },
  resolve: {
    target: 'RESOLVED',
    sql: `UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('OPEN', 'ACKNOWLEDGED') RETURNING *`,
  },
} as const;

export type AlertAction = keyof typeof transitions;

/**
 * Applies a lifecycle transition atomically with a conditional UPDATE (FR-9, NFR-5).
 * Repeating an applied transition returns the alert unchanged; anything else that
 * the UPDATE did not match is a 409.
 */
export async function transitionAlert(
  db: pg.Pool,
  id: string,
  action: AlertAction,
): Promise<Alert> {
  const { target, sql } = transitions[action];
  const updated = await db.query<AlertRow>(sql, [id]);
  if (updated.rows[0]) return toAlert(updated.rows[0]);

  const current = await getAlert(db, id);
  if (!current) throw notFound('Alert');
  if (current.status === target) return current;
  throw new HttpError(409, `Cannot ${action} an alert that is ${current.status}`);
}
