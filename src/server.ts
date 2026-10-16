import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { pendingMigrations } from './db/migrate.js';
import { checkConnection, createPool } from './db/pool.js';
import { RuleEngine } from './engine/engine.js';

// Startup (T3.7): DB reachable -> schema up to date -> rules + window warm-up -> listen.
const config = loadConfig();
const pool = createPool({ connectionString: config.databaseUrl, max: config.pgPoolMax });
await checkConnection(pool);

const pending = await pendingMigrations(pool);
if (pending.length) {
  console.error(`Pending migrations: ${pending.join(', ')}. Run "pnpm db:migrate" first.`);
  await pool.end();
  process.exit(1);
}

const engine = new RuleEngine(pool);
await engine.loadAll();
const sweeper = setInterval(() => engine.windows.sweep(), 60_000);
sweeper.unref();

const app = buildApp({ config, pool, engine });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal, queued: app.pipeline.depth }, 'shutting down');
  try {
    clearInterval(sweeper);
    // Stops accepting, lets in-flight requests finish, then drains the ingest pipeline.
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: '127.0.0.1' });
app.log.info({ rules: engine.registry.size }, 'rules loaded');
