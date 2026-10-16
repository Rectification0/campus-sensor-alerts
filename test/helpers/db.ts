import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';

export const testDbUrl = process.env.TEST_DATABASE_URL;

/** Drops everything in the test database and re-applies migrations. */
export async function resetTestDb(): Promise<void> {
  if (!testDbUrl) throw new Error('TEST_DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: testDbUrl });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await migrate(testDbUrl);
}

export async function insertReadings(
  pool: pg.Pool,
  rows: { sensorId: string; type: string; value: number; ts: string | number | Date }[],
): Promise<void> {
  await pool.query(
    `INSERT INTO readings (sensor_id, type, value, recorded_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::float8[], $4::timestamptz[])`,
    [
      rows.map((r) => r.sensorId),
      rows.map((r) => r.type),
      rows.map((r) => r.value),
      rows.map((r) => new Date(r.ts).toISOString()),
    ],
  );
}
