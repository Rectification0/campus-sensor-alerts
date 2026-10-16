import type pg from 'pg';
import type { AlertUpsert, Reading } from '../engine/evaluator.js';

export interface CommitResult {
  alertsCreated: number;
  alertsUpdated: number;
}

/**
 * Stores a batch of readings and applies its alert upserts in one transaction (design §7.2),
 * so a reading is never stored without its alert change, or vice versa.
 */
export async function commitBatch(
  db: pg.Pool,
  readings: readonly Reading[],
  alerts: readonly AlertUpsert[],
): Promise<CommitResult> {
  const client = await db.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    // Array parameters keep this to 4 bind values regardless of batch size.
    await client.query(
      `INSERT INTO readings (sensor_id, type, value, recorded_at)
       SELECT s, t, v, to_timestamp(ms / 1000.0)
       FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[]) AS u(s, t, v, ms)`,
      [
        readings.map((r) => r.sensorId),
        readings.map((r) => r.type),
        readings.map((r) => r.value),
        readings.map((r) => r.ts),
      ],
    );

    let result: CommitResult = { alertsCreated: 0, alertsUpdated: 0 };
    if (alerts.length) {
      // A consistent lock order prevents deadlocks between overlapping batch transactions.
      const sorted = [...alerts].sort((a, b) =>
        a.ruleId < b.ruleId
          ? -1
          : a.ruleId > b.ruleId
            ? 1
            : a.sensorId < b.sensorId
              ? -1
              : a.sensorId > b.sensorId
                ? 1
                : 0,
      );
      const { rows } = await client.query<{ inserted: boolean }>(
        `INSERT INTO alerts (rule_id, sensor_id, type, trigger_value, last_value, window_start,
                             window_end, first_triggered_at, last_triggered_at, trigger_count)
         SELECT rule_id, sensor_id, type, trigger_value, last_value,
                to_timestamp(ws / 1000.0), to_timestamp(we / 1000.0),
                to_timestamp(ft / 1000.0), to_timestamp(lt / 1000.0), cnt
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::float8[], $5::float8[],
                     $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::int[])
              AS u(rule_id, sensor_id, type, trigger_value, last_value, ws, we, ft, lt, cnt)
         ON CONFLICT (rule_id, sensor_id) WHERE status <> 'RESOLVED'
         DO UPDATE SET
           trigger_count     = alerts.trigger_count + EXCLUDED.trigger_count,
           last_value        = CASE WHEN EXCLUDED.last_triggered_at >= alerts.last_triggered_at
                                    THEN EXCLUDED.last_value ELSE alerts.last_value END,
           last_triggered_at = GREATEST(alerts.last_triggered_at, EXCLUDED.last_triggered_at),
           updated_at        = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          sorted.map((a) => a.ruleId),
          sorted.map((a) => a.sensorId),
          sorted.map((a) => a.type),
          sorted.map((a) => a.triggerValue),
          sorted.map((a) => a.lastValue),
          sorted.map((a) => a.windowStart),
          sorted.map((a) => a.windowEnd),
          sorted.map((a) => a.firstTriggeredAt),
          sorted.map((a) => a.lastTriggeredAt),
          sorted.map((a) => a.triggerCount),
        ],
      );
      const created = rows.filter((r) => r.inserted).length;
      result = { alertsCreated: created, alertsUpdated: rows.length - created };
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    failed = true;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    // A connection that saw an error may be broken; discard it rather than reuse it.
    client.release(failed);
  }
}
