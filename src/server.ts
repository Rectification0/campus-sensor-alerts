import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { checkConnection, createPool } from './db/pool.js';
import { RuleEngine } from './engine/engine.js';

const config = loadConfig();
const pool = createPool({ connectionString: config.databaseUrl, max: config.pgPoolMax });
await checkConnection(pool);

const engine = new RuleEngine(pool);
await engine.loadAll();
const sweeper = setInterval(() => engine.windows.sweep(), 60_000);
sweeper.unref();

const app = buildApp({ config, pool, engine });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    clearInterval(sweeper);
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
