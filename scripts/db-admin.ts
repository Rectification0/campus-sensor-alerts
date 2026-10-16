import pg from 'pg';

/**
 * Creates the database named in `url` if it does not exist (`reset` drops it first).
 * Connects to the `postgres` maintenance database on the same server.
 */
export async function ensureDatabase(
  url: string,
  { reset = false, log = console.log }: { reset?: boolean; log?: (msg: string) => void } = {},
): Promise<void> {
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(dbName))
    throw new Error(`Refusing unusual database name "${dbName}"`);

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    if (reset) {
      await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      log(`Dropped database ${dbName}`);
    }
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (rowCount) {
      log(`Database ${dbName} already exists`);
    } else {
      await client.query(`CREATE DATABASE "${dbName}"`);
      log(`Created database ${dbName}`);
    }
  } finally {
    await client.end();
  }
}
