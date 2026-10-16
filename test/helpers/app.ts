import type pg from 'pg';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { RuleEngine } from '../../src/engine/engine.js';
import { testDbUrl } from './db.js';

/** Builds an app against the test database; env-style overrides tweak the config. */
export function makeApp(pool: pg.Pool, env: Record<string, string> = {}) {
  const config = loadConfig({ DATABASE_URL: testDbUrl, LOG_LEVEL: 'silent', ...env });
  const engine = new RuleEngine(pool);
  return { app: buildApp({ config, pool, engine }), engine };
}
