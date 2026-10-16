import pg from 'pg';

export interface PoolOptions {
  connectionString: string;
  max?: number;
}

export function createPool({ connectionString, max = 10 }: PoolOptions): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  // An idle client erroring (e.g. the server restarting) must not crash the process;
  // the next query on that pool will surface the problem.
  pool.on('error', (err) => {
    console.error('Idle PostgreSQL client error:', err.message);
  });
  return pool;
}

/** Throws if the database is unreachable. */
export async function checkConnection(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
