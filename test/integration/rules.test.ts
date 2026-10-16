import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { RuleEngine } from '../../src/engine/engine.js';
import { insertReadings, resetTestDb, testDbUrl } from '../helpers/db.js';

describe.skipIf(!testDbUrl)('rules API (FR-4)', () => {
  let pool: pg.Pool;
  let engine: RuleEngine;
  let app: App;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testDbUrl });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDb();
    engine = new RuleEngine(pool);
    const config = loadConfig({ DATABASE_URL: testDbUrl, LOG_LEVEL: 'silent' });
    app = buildApp({ config, pool, engine });
  });

  const post = (url: string, payload?: object) =>
    app.inject({ method: 'POST', url: `/api/v1${url}`, ...(payload ? { payload } : {}) });

  const windowRule = {
    kind: 'WINDOW',
    type: 'temperature',
    operator: 'gt',
    threshold: 28,
    aggregation: 'avg',
    windowSeconds: 600,
  };

  it('creates, lists and gets rules', async () => {
    const created = await post('/rules', {
      kind: 'THRESHOLD',
      type: 'temperature',
      operator: 'gt',
      threshold: 30,
    });
    expect(created.statusCode).toBe(201);
    const rule = created.json();
    expect(rule).toMatchObject({
      kind: 'THRESHOLD',
      threshold: 30,
      aggregation: null,
      windowSeconds: null,
      enabled: true,
    });
    expect(rule.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(engine.registry.get(rule.id)).toBeDefined();

    const list = await app.inject({ method: 'GET', url: '/api/v1/rules' });
    expect(list.json().items.map((r: { id: string }) => r.id)).toEqual([rule.id]);
    const one = await app.inject({ method: 'GET', url: `/api/v1/rules/${rule.id}` });
    expect(one.json()).toEqual(rule);
  });

  it('rejects invalid rules with field errors', async () => {
    const missing = await post('/rules', {
      kind: 'WINDOW',
      type: 'temperature',
      operator: 'gt',
      threshold: 28,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().errors.map((e: { path: string }) => e.path)).toEqual([
      '/aggregation',
      '/windowSeconds',
    ]);

    const extra = await post('/rules', { ...windowRule, kind: 'THRESHOLD' });
    expect(extra.statusCode).toBe(400);

    const badOp = await post('/rules', { ...windowRule, operator: 'eq', name: 'x' });
    expect(badOp.statusCode).toBe(400);
    expect(badOp.json().errors.length).toBeGreaterThanOrEqual(2);

    const badWindow = await post('/rules', { ...windowRule, windowSeconds: 5 });
    expect(badWindow.statusCode).toBe(400);
  });

  it('returns 404 for unknown ids and 400 for malformed ids', async () => {
    const id = '0190a6e2-0000-7000-8000-000000000000';
    expect((await app.inject({ method: 'GET', url: `/api/v1/rules/${id}` })).statusCode).toBe(404);
    expect((await post(`/rules/${id}/enable`)).statusCode).toBe(404);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rules/${id}`,
      payload: { threshold: 1 },
    });
    expect(patch.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/rules/nope' })).statusCode).toBe(400);
  });

  it('edits rules and applies the change immediately (FR-4.2, FR-4.5)', async () => {
    const rule = (await post('/rules', windowRule)).json();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rules/${rule.id}`,
      payload: { kind: 'THRESHOLD', threshold: 35 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      kind: 'THRESHOLD',
      threshold: 35,
      aggregation: null,
      windowSeconds: null,
    });
    expect(engine.registry.get(rule.id)?.threshold).toBe(35);
    expect(engine.windows.ruleCount).toBe(0);

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rules/${rule.id}`,
      payload: { kind: 'WINDOW' },
    });
    expect(invalid.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rules/${rule.id}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it('enables and disables idempotently (FR-4.3)', async () => {
    const rule = (await post('/rules', { ...windowRule, enabled: false })).json();
    expect(engine.registry.get(rule.id)).toBeUndefined();

    const enabled = (await post(`/rules/${rule.id}/enable`)).json();
    expect(enabled.enabled).toBe(true);
    expect(engine.registry.get(rule.id)).toBeDefined();
    const again = (await post(`/rules/${rule.id}/enable`)).json();
    expect(again.updatedAt).toBe(enabled.updatedAt);

    const disabled = await post(`/rules/${rule.id}/disable`);
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().enabled).toBe(false);
    expect(engine.registry.get(rule.id)).toBeUndefined();
    expect((await post(`/rules/${rule.id}/disable`)).statusCode).toBe(200);
  });

  it('warms WINDOW rules up from history stored before the rule existed (FR-6.3)', async () => {
    const base = Date.parse('2026-10-12T10:00:00Z');
    await insertReadings(pool, [
      { sensorId: 'lab', type: 'temperature', value: 10, ts: base }, // outside the window by the end
      { sensorId: 'lab', type: 'temperature', value: 27, ts: base + 5 * 60_000 },
      { sensorId: 'lab', type: 'temperature', value: 28, ts: base + 11 * 60_000 },
      { sensorId: 'lib', type: 'temperature', value: 50, ts: base },
      { sensorId: 'lab', type: 'humidity', value: 90, ts: base },
    ]);
    const rule = (await post('/rules', windowRule)).json();
    expect(engine.windows.get(rule.id, 'lab')?.size).toBe(2);
    expect(engine.windows.get(rule.id, 'lib')?.size).toBe(1);

    // avg(27, 28, 30.2) = 28.4 > 28 -> matches using pre-existing history.
    const { alerts } = engine.evaluate([
      { sensorId: 'lab', type: 'temperature', value: 30.2, ts: base + 12 * 60_000 },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.triggerValue).toBeCloseTo(28.4);
  });

  it('loadAll restores enabled rules and windows after a restart', async () => {
    const rule = (await post('/rules', windowRule)).json();
    await post('/rules', {
      kind: 'THRESHOLD',
      type: 'co2',
      operator: 'gt',
      threshold: 1000,
      enabled: false,
    });
    await insertReadings(pool, [
      { sensorId: 'lab', type: 'temperature', value: 27, ts: new Date() },
    ]);

    const restarted = new RuleEngine(pool);
    await restarted.loadAll();
    expect(restarted.registry.size).toBe(1);
    expect(restarted.windows.get(rule.id, 'lab')?.size).toBe(1);
  });
});
