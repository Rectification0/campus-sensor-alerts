// Creates the application database (or the test database with --test) if it does not exist.
// --reset drops and recreates it first.
//
//   pnpm db:create              -> DATABASE_URL
//   pnpm db:test:reset          -> TEST_DATABASE_URL, dropped and recreated

import pg from 'pg';

const args = new Set(process.argv.slice(2));
const useTest = args.has('--test');
const reset = args.has('--reset');

const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!url) {
  console.error(`${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is not set (see .env.example)`);
  process.exit(1);
}

const target = new URL(url);
const dbName = decodeURIComponent(target.pathname.slice(1));
if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
  console.error(`Refusing unusual database name "${dbName}"`);
  process.exit(1);
}

// Connect to the maintenance database on the same server.
const admin = new URL(url);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();

try {
  if (reset) {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    console.log(`Dropped database ${dbName}`);
  }
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (rowCount) {
    console.log(`Database ${dbName} already exists`);
  } else {
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Created database ${dbName}`);
  }
} finally {
  await client.end();
}
