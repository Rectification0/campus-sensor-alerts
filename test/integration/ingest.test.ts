import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from '../helpers/app.js';
import { resetTestDb, testDbUrl } from '../helpers/db.js';

const reading = (over: Record<string, unknown> = {}) => ({
  sensorId: 'library-floor-2',
  type: 'temperature',
  value: 34.5,
  timestamp: '2026-10-12T10:30:00Z',
  ...over,
});

describe.skipIf(!testDbUrl)('ingestion (FR-1, FR-2, FR-3, FR-7)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDbUrl });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDb();
  });

  const count = async (table: 'readings' | 'alerts') =>
    (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

  describe('POST /readings', () => {
    it('replies 202 only after the reading is committed (FR-1.1)', async () => {
      const { app } = makeApp(pool);
      const res = await app.inject({ method: 'POST', url: '/api/v1/readings', payload: reading() });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: 1 });
      // No flush call needed: the 202 itself means it is stored.
      const { rows } = await pool.query('SELECT sensor_id, type, value, recorded_at FROM readings');
      expect(rows).toEqual([
        {
          sensor_id: 'library-floor-2',
          type: 'temperature',
          value: 34.5,
          recorded_at: new Date('2026-10-12T10:30:00Z'),
        },
      ]);
    });

    it('rejects invalid readings with 400 and stores nothing (FR-1.2)', async () => {
      const { app } = makeApp(pool);
      const post = (payload: unknown) =>
        app.inject({ method: 'POST', url: '/api/v1/readings', payload: payload as object });

      const extra = await post(reading({ unit: 'C' }));
      expect(extra.statusCode).toBe(400);
      expect((await post(reading({ value: '34.5' }))).statusCode).toBe(400);
      expect((await post(reading({ timestamp: '2026-10-12T10:30:00' }))).statusCode).toBe(400);
      const missing = await post({ sensorId: 'x', type: 't' });
      expect(missing.json().errors.length).toBe(2);

      const inf = await app.inject({
        method: 'POST',
        url: '/api/v1/readings',
        headers: { 'content-type': 'application/json' },
        payload: '{"sensorId":"s","type":"t","value":1e999,"timestamp":"2026-10-12T10:30:00Z"}',
      });
      expect(inf.statusCode).toBe(400);
      expect(inf.json().errors.map((e: { path: string }) => e.path)).toEqual(['/value']);
      expect(await count('readings')).toBe(0);
    });
  });

  describe('POST /readings/batch', () => {
    it('accepts valid items and reports invalid ones by index (FR-2.2)', async () => {
      const { app } = makeApp(pool);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/readings/batch',
        payload: [reading(), reading({ value: 'hot' }), reading({ sensorId: 'lab' }), 7],
      });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.accepted).toBe(2);
      expect(body.rejected.map((r: { index: number }) => r.index)).toEqual([1, 3]);
      expect(body.rejected[0].errors[0].path).toBe('/value');
      expect(await count('readings')).toBe(2);
    });

    it('returns 400 when every item is invalid or the envelope is wrong (FR-2.3)', async () => {
      const { app } = makeApp(pool, { BATCH_MAX_ITEMS: '3' });
      const post = (payload: unknown) =>
        app.inject({ method: 'POST', url: '/api/v1/readings/batch', payload: payload as object });

      const allBad = await post([{ a: 1 }, reading({ value: null })]);
      expect(allBad.statusCode).toBe(400);
      expect(allBad.json()).toMatchObject({ accepted: 0, rejected: [{ index: 0 }, { index: 1 }] });
      expect((await post([])).statusCode).toBe(400);
      expect((await post([reading(), reading(), reading(), reading()])).statusCode).toBe(400);
      expect((await post(reading())).statusCode).toBe(400);
      expect(await count('readings')).toBe(0);
    });

    it('returns 413 when the body exceeds the limit (FR-2.3)', async () => {
      const { app } = makeApp(pool, { BODY_LIMIT_BYTES: '500' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/readings/batch',
        payload: Array.from({ length: 10 }, () => reading()),
      });
      expect(res.statusCode).toBe(413);
    });
  });

  describe('backpressure and durability (FR-3.3, NFR-3)', () => {
    it('returns 503 + Retry-After when the buffer cannot hold the request', async () => {
      const { app } = makeApp(pool, { BUFFER_CAPACITY: '5' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/readings/batch',
        payload: Array.from({ length: 6 }, () => reading()),
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(await count('readings')).toBe(0);
    });

    it('returns 503 and stores nothing when the database stays unreachable', async () => {
      const deadPool = new pg.Pool({
        connectionString: 'postgres://postgres:x@127.0.0.1:1/none',
        connectionTimeoutMillis: 200,
      });
      deadPool.on('error', () => {});
      const { app } = makeApp(deadPool, { COMMIT_RETRY_BUDGET_MS: '300' });
      const res = await app.inject({ method: 'POST', url: '/api/v1/readings', payload: reading() });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      await deadPool.end();
      expect(await count('readings')).toBe(0);
    });

    it('commits everything queued before closing (graceful shutdown)', async () => {
      const { app } = makeApp(pool, { FLUSH_INTERVAL_MS: '1000' });
      await app.ready();
      const pending = Array.from({ length: 5 }, (_, i) =>
        app.inject({ method: 'POST', url: '/api/v1/readings', payload: reading({ value: i }) }),
      );
      // Wait until all five are queued; the 1 s flush timer has not fired yet.
      while (app.pipeline.depth < 5) await new Promise((r) => setTimeout(r, 5));
      await app.close();
      const statuses = (await Promise.all(pending)).map((r) => r.statusCode);
      expect(statuses).toEqual([202, 202, 202, 202, 202]);
      expect(await count('readings')).toBe(5);
    });

    it('after a failed commit, rebuilds windows from stored data; a retry then succeeds', async () => {
      // Make inserts for one sensor fail inside the database.
      await pool.query(`
        CREATE FUNCTION fail_readings() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.sensor_id = 'fail-me' THEN RAISE EXCEPTION 'injected failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fail_readings BEFORE INSERT ON readings
          FOR EACH ROW EXECUTE FUNCTION fail_readings();`);
      const { app, engine } = makeApp(pool, { COMMIT_RETRY_BUDGET_MS: '200' });
      const rule = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/rules',
          payload: {
            kind: 'WINDOW',
            type: 'temperature',
            operator: 'gt',
            threshold: 1000,
            aggregation: 'avg',
            windowSeconds: 600,
          },
        })
      ).json();
      const post = (sensorId: string) =>
        app.inject({ method: 'POST', url: '/api/v1/readings', payload: reading({ sensorId }) });

      expect((await post('ok')).statusCode).toBe(202);
      const failed = await post('fail-me');
      expect(failed.statusCode).toBe(503);
      expect(failed.headers['retry-after']).toBe('1');
      await app.pipeline.flushAll(); // wait for the post-failure window rebuild

      // The never-stored reading is gone from window state; stored ones remain.
      expect(engine.windows.get(rule.id, 'fail-me')).toBeUndefined();
      expect(engine.windows.get(rule.id, 'ok')?.size).toBe(1);
      expect(await count('readings')).toBe(1);

      // 503 means nothing was stored, so the client can safely retry.
      await pool.query('DROP TRIGGER fail_readings ON readings');
      expect((await post('fail-me')).statusCode).toBe(202);
      expect(await count('readings')).toBe(2);
      expect(engine.windows.get(rule.id, 'fail-me')?.size).toBe(1);
    });
  });

  describe('storage semantics', () => {
    it('stores duplicate readings as sent (FR-3.4)', async () => {
      const { app } = makeApp(pool);
      for (let i = 0; i < 2; i++) {
        await app.inject({ method: 'POST', url: '/api/v1/readings', payload: reading() });
      }
      expect(await count('readings')).toBe(2);
    });

    it('normalises timezone offsets and returns UTC timestamps (NFR-6)', async () => {
      const { app } = makeApp(pool);
      await app.inject({
        method: 'POST',
        url: '/api/v1/rules',
        payload: { kind: 'THRESHOLD', type: 'temperature', operator: 'gt', threshold: 30 },
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/readings',
        payload: reading({ timestamp: '2026-10-12T16:00:00+05:30' }),
      });
      const { rows } = await pool.query('SELECT recorded_at FROM readings');
      expect(rows[0].recorded_at).toEqual(new Date('2026-10-12T10:30:00Z'));
      const alert = (await app.inject({ method: 'GET', url: '/api/v1/alerts' })).json().items[0];
      expect(alert.firstTriggeredAt).toBe('2026-10-12T10:30:00.000Z');
      expect(alert.createdAt).toMatch(/Z$/);
    });
  });

  describe('alerts from ingested readings (FR-5, FR-6, FR-7)', () => {
    const createRule = async (app: ReturnType<typeof makeApp>['app'], rule: object) =>
      (await app.inject({ method: 'POST', url: '/api/v1/rules', payload: rule })).json();

    it('creates one active alert per (rule, sensor) and counts repeat triggers', async () => {
      const { app } = makeApp(pool);
      const rule = await createRule(app, {
        kind: 'THRESHOLD',
        type: 'temperature',
        operator: 'gt',
        threshold: 30,
      });
      const send = (value: number, minute: number, sensorId = 'library-floor-2') =>
        app.inject({
          method: 'POST',
          url: '/api/v1/readings',
          payload: reading({ value, sensorId, timestamp: `2026-10-12T10:${minute}:00Z` }),
        });

      await send(34.5, 10);
      await send(20, 11); // below threshold
      await send(36, 12);
      await send(40, 13, 'lab');

      const { rows } = await pool.query(
        `SELECT rule_id, sensor_id, status, trigger_value, last_value, trigger_count,
                first_triggered_at, last_triggered_at
         FROM alerts ORDER BY sensor_id`,
      );
      expect(rows).toEqual([
        expect.objectContaining({ sensor_id: 'lab', trigger_count: 1 }),
        {
          rule_id: rule.id,
          sensor_id: 'library-floor-2',
          status: 'OPEN',
          trigger_value: 34.5,
          last_value: 36,
          trigger_count: 2,
          first_triggered_at: new Date('2026-10-12T10:10:00Z'),
          last_triggered_at: new Date('2026-10-12T10:12:00Z'),
        },
      ]);

      // After resolution, the next trigger opens a new alert (FR-7.4).
      await pool.query(`UPDATE alerts SET status = 'RESOLVED' WHERE sensor_id = 'library-floor-2'`);
      await send(31, 14);
      const { rows: lib } = await pool.query(
        `SELECT status, trigger_count FROM alerts WHERE sensor_id = 'library-floor-2' ORDER BY id`,
      );
      expect(lib).toEqual([
        { status: 'RESOLVED', trigger_count: 2 },
        { status: 'OPEN', trigger_count: 1 },
      ]);
    });

    it('raises a WINDOW alert on the ten-minute average with window bounds', async () => {
      const { app } = makeApp(pool);
      await createRule(app, {
        kind: 'WINDOW',
        type: 'temperature',
        operator: 'gt',
        threshold: 28,
        aggregation: 'avg',
        windowSeconds: 600,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/readings/batch',
        payload: [
          reading({ value: 30.2, timestamp: '2026-10-12T10:02:00Z' }),
          reading({ value: 27, timestamp: '2026-10-12T10:00:00Z' }),
          reading({ value: 28, timestamp: '2026-10-12T10:01:00Z' }),
        ],
      });
      expect(res.statusCode).toBe(202);
      const { rows } = await pool.query(
        'SELECT trigger_value, window_start, window_end, trigger_count FROM alerts',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].trigger_value).toBeCloseTo(28.4, 9);
      expect(rows[0].window_start).toEqual(new Date('2026-10-12T10:00:00Z'));
      expect(rows[0].window_end).toEqual(new Date('2026-10-12T10:02:00Z'));
    });

    it('handles concurrent batches without losing readings or triggers', async () => {
      const { app } = makeApp(pool, { FLUSH_MAX_ROWS: '150', FLUSH_CONCURRENCY: '3' });
      await createRule(app, {
        kind: 'THRESHOLD',
        type: 'temperature',
        operator: 'gte',
        threshold: 0,
      });
      const batches = Array.from({ length: 20 }, (_, b) =>
        Array.from({ length: 100 }, (_, i) =>
          reading({
            sensorId: `s${i % 10}`,
            value: b + i,
            timestamp: new Date(b * 1000 + i).toISOString(),
          }),
        ),
      );
      const results = await Promise.all(
        batches.map((payload) =>
          app.inject({ method: 'POST', url: '/api/v1/readings/batch', payload }),
        ),
      );
      expect(results.every((r) => r.statusCode === 202)).toBe(true);
      expect(await count('readings')).toBe(2000);
      const { rows } = await pool.query(
        'SELECT count(*)::int AS alerts, sum(trigger_count)::int AS triggers FROM alerts',
      );
      expect(rows[0]).toEqual({ alerts: 10, triggers: 2000 });
    });
  });
});
