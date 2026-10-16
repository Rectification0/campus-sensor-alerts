// Typed application config parsed from environment variables (design §4).

export interface Config {
  port: number;
  databaseUrl: string;
  testDatabaseUrl: string | undefined;
  pgPoolMax: number;
  bufferCapacity: number;
  flushIntervalMs: number;
  flushMaxRows: number;
  flushConcurrency: number;
  commitRetryBudgetMs: number;
  batchMaxItems: number;
  bodyLimitBytes: number;
  logLevel: string;
  requestLogging: boolean;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`Invalid ${name}: expected an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`Invalid ${name}: expected true/false, got "${raw}"`);
}

export function loadConfig(env: Env = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }
  return Object.freeze({
    port: int(env, 'PORT', 3000, 0),
    databaseUrl,
    testDatabaseUrl: env.TEST_DATABASE_URL || undefined,
    pgPoolMax: int(env, 'PG_POOL_MAX', 10),
    bufferCapacity: int(env, 'BUFFER_CAPACITY', 100_000),
    flushIntervalMs: int(env, 'FLUSH_INTERVAL_MS', 10),
    flushMaxRows: int(env, 'FLUSH_MAX_ROWS', 2000),
    flushConcurrency: int(env, 'FLUSH_CONCURRENCY', 3),
    commitRetryBudgetMs: int(env, 'COMMIT_RETRY_BUDGET_MS', 5000),
    batchMaxItems: int(env, 'BATCH_MAX_ITEMS', 1000),
    bodyLimitBytes: int(env, 'BODY_LIMIT_BYTES', 1_048_576),
    logLevel: env.LOG_LEVEL || 'info',
    requestLogging: bool(env, 'REQUEST_LOGGING', true),
  });
}
