import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, pendingMigrations } from '../../src/db/migrate.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('migrations (TEST_DATABASE_URL)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    // Start from an empty schema so the test is repeatable.
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await admin.end();
    pool = new pg.Pool({ connectionString: url });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('applies 001_init.sql once and is idempotent', async () => {
    // The startup check (T3.7) reports unapplied files, even before schema_migrations exists.
    expect(await pendingMigrations(pool)).toEqual(['001_init.sql']);
    expect(await migrate(url!)).toEqual(['001_init.sql']);
    expect(await pendingMigrations(pool)).toEqual([]);
    expect(await migrate(url!)).toEqual([]);
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'alerts',
      'readings',
      'rules',
      'schema_migrations',
    ]);
  });

  it('enforces WINDOW/THRESHOLD field consistency on rules', async () => {
    await expect(
      pool.query(
        `INSERT INTO rules (kind, type, operator, threshold) VALUES ('WINDOW','temperature','gt',28)`,
      ),
    ).rejects.toThrow(/rules_window_fields/);
    await expect(
      pool.query(
        `INSERT INTO rules (kind, type, operator, threshold, aggregation, window_seconds)
         VALUES ('THRESHOLD','temperature','gt',30,'avg',600)`,
      ),
    ).rejects.toThrow(/rules_window_fields/);
  });

  it('allows at most one active alert per (rule, sensor)', async () => {
    const {
      rows: [rule],
    } = await pool.query(
      `INSERT INTO rules (kind, type, operator, threshold) VALUES ('THRESHOLD','temperature','gt',30) RETURNING id`,
    );
    const insertAlert = (status = 'OPEN') =>
      pool.query(
        `INSERT INTO alerts (rule_id, sensor_id, type, status, trigger_value, last_value,
                             first_triggered_at, last_triggered_at)
         VALUES ($1, 'library-floor-2', 'temperature', $2, 34.5, 34.5, now(), now())`,
        [rule.id, status],
      );

    await insertAlert('OPEN');
    await expect(insertAlert('ACKNOWLEDGED')).rejects.toThrow(/alerts_one_active/);
    // Resolved alerts do not count as active.
    await pool.query(`UPDATE alerts SET status = 'RESOLVED' WHERE rule_id = $1`, [rule.id]);
    await insertAlert('OPEN');
    await insertAlert('RESOLVED');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM alerts WHERE rule_id = $1', [
      rule.id,
    ]);
    expect(rows[0].n).toBe(3);
  });

  it('generates time-ordered UUIDv7 ids', async () => {
    const { rows } = await pool.query(`SELECT uuid_extract_version(uuidv7()) AS v`);
    expect(rows[0].v).toBe(7);
  });
});
