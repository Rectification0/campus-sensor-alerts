// Applies src/db/migrations/*.sql in filename order, each in its own transaction,
// recording applied files in schema_migrations.
//
//   pnpm db:migrate           -> DATABASE_URL
//   tsx src/db/migrate.ts --test  -> TEST_DATABASE_URL

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
// Arbitrary constant key so concurrent migrators (e.g. parallel test workers) serialise.
const LOCK_KEY = 7_142_026;

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

/** Migration files not yet applied to the database the pool points at. */
export async function pendingMigrations(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('schema_migrations') IS NOT NULL AS exists`,
  );
  const done = new Set<string>();
  if (rows[0]?.exists) {
    const applied = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    for (const r of applied.rows) done.add(r.name);
  }
  return (await migrationFiles()).filter((f) => !done.has(f));
}

export async function migrate(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    const files = await migrationFiles();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(MIGRATIONS_DIR + file, 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const useTest = process.argv.includes('--test');
  const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) {
    console.error(
      `${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is not set (see .env.example)`,
    );
    process.exit(1);
  }
  const applied = await migrate(url);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
}
