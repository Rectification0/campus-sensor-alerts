// Creates the application database (or the test database with --test) if it does not exist.
// --reset drops and recreates it first.
//
//   pnpm db:create              -> DATABASE_URL
//   pnpm db:test:reset          -> TEST_DATABASE_URL, dropped and recreated

import { ensureDatabase } from './db-admin.js';

const args = new Set(process.argv.slice(2));
const useTest = args.has('--test');

const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!url) {
  console.error(`${useTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is not set (see .env.example)`);
  process.exit(1);
}

await ensureDatabase(url, { reset: args.has('--reset') });
