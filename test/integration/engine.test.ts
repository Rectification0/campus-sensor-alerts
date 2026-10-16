// End-to-end: rules + HTTP ingestion -> alerts in PostgreSQL (T5.3, T5.4).

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from '../helpers/app.js';
import { insertReadings, resetTestDb, testDbUrl } from '../helpers/db.js';

type TestApp = ReturnType<typeof makeApp>['app'];

const at = (minute: number, second = 0) =>
  `2026-10-12T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;

const windowAvgRule = {
  kind: 'WINDOW',
  type: 'temperature',
  operator: 'gt',
  threshold: 28,
  aggregation: 'avg',
  windowSeconds: 600,
};
const thresholdRule = { kind: 'THRESHOLD', type: 'temperature', operator: 'gt', threshold: 30 };

describe.skipIf(!testDbUrl)('rules -> ingestion -> alerts (FR-4..FR-7)', () => {
  let pool: pg.Pool;
  let app: TestApp;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDbUrl });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDb();
    app = makeApp(pool).app;
  });

  async function createRule(target: TestApp, rule: object) {
    const res = await target.inject({ method: 'POST', url: '/api/v1/rules', payload: rule });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  async function send(target: TestApp, value: number, timestamp: string, sensorId = 'lab') {
    const res = await target.inject({
      method: 'POST',
      url: '/api/v1/readings',
      payload: { sensorId, type: 'temperature', value, timestamp },
    });
    expect(res.statusCode).toBe(202);
  }

  async function alerts() {
    const { rows } = await pool.query(
      `SELECT rule_id, sensor_id, status, trigger_value, last_value, trigger_count
       FROM alerts ORDER BY id`,
    );
    return rows;
  }

  describe('rule changes (FR-4.5, FR-4.6)', () => {
    it('an edited threshold applies to the next reading and leaves existing alerts untouched', async () => {
      const rule = await createRule(app, thresholdRule);
      await send(app, 34.5, at(0));
      const before = await alerts();
      expect(before).toEqual([expect.objectContaining({ trigger_value: 34.5, trigger_count: 1 })]);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/v1/rules/${rule.id}`,
        payload: { threshold: 40 },
      });
      expect(patch.statusCode).toBe(200);
      expect(await alerts()).toEqual(before); // the edit itself changes no alert

      await send(app, 35, at(1)); // above the old threshold, below the new one
      expect(await alerts()).toEqual(before);
      await send(app, 41, at(2));
      expect(await alerts()).toEqual([
        expect.objectContaining({ trigger_value: 34.5, last_value: 41, trigger_count: 2 }),
      ]);
    });

    it('a disabled rule does not fire; re-enabling it does; its alerts stay as they were', async () => {
      const rule = await createRule(app, thresholdRule);
      await send(app, 35, at(0));
      const before = await alerts();

      await app.inject({ method: 'POST', url: `/api/v1/rules/${rule.id}/disable` });
      expect(await alerts()).toEqual(before);
      await send(app, 50, at(1));
      expect(await alerts()).toEqual(before);

      await app.inject({ method: 'POST', url: `/api/v1/rules/${rule.id}/enable` });
      await send(app, 51, at(2));
      expect(await alerts()).toEqual([
        expect.objectContaining({ last_value: 51, trigger_count: 2 }),
      ]);
    });

    it('a rule created disabled never fires', async () => {
      await createRule(app, { ...thresholdRule, enabled: false });
      await send(app, 99, at(0));
      expect(await alerts()).toEqual([]);
    });

    it('a rule only evaluates readings of its own metric type', async () => {
      await createRule(app, { ...thresholdRule, type: 'co2', threshold: 1000 });
      await send(app, 5000, at(0)); // temperature reading
      expect(await alerts()).toEqual([]);
    });
  });

  describe('WINDOW rules use stored history (FR-6.3)', () => {
    it('includes readings stored before the rule was created', async () => {
      await insertReadings(pool, [
        { sensorId: 'lab', type: 'temperature', value: 27, ts: at(0) },
        { sensorId: 'lab', type: 'temperature', value: 28, ts: at(1) },
      ]);
      const rule = await createRule(app, windowAvgRule);
      await send(app, 30.2, at(2)); // avg(27, 28, 30.2) = 28.4 > 28
      const rows = await alerts();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rule_id: rule.id, sensor_id: 'lab', trigger_count: 1 });
      expect(rows[0].trigger_value).toBeCloseTo(28.4, 9);
    });

    it('survives a restart: a new process warms windows from the database', async () => {
      await createRule(app, windowAvgRule);
      await send(app, 27, at(0));
      await send(app, 28, at(1));
      expect(await alerts()).toEqual([]);
      await app.close();

      const restarted = makeApp(pool);
      await restarted.engine.loadAll();
      await send(restarted.app, 30.2, at(2));
      const rows = await alerts();
      expect(rows).toHaveLength(1);
      expect(rows[0].trigger_value).toBeCloseTo(28.4, 9);
      await restarted.app.close();
    });

    it('drops readings that fall out of the window', async () => {
      await createRule(app, windowAvgRule);
      await send(app, 100, at(0));
      await send(app, 20, at(10)); // the 100 is exactly 600 s old: outside (t - 600 s, t]
      const rows = await alerts();
      expect(rows).toHaveLength(1); // only the first reading's own window fired
      expect(rows[0]).toMatchObject({ trigger_value: 100, last_value: 100, trigger_count: 1 });
    });
  });

  it('late readings are stored and hit THRESHOLD rules but not windows (FR-6.4)', async () => {
    const hot = await createRule(app, { ...thresholdRule, threshold: 50 });
    await createRule(app, windowAvgRule);
    await send(app, 20, at(5));
    await send(app, 100, at(0)); // late: older than the newest reading for this sensor
    await send(app, 21, at(6)); // window avg(20, 21) = 20.5: no window alert

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM readings');
    expect(rows[0].n).toBe(3);
    expect(await alerts()).toEqual([
      expect.objectContaining({ rule_id: hot.id, trigger_value: 100, trigger_count: 1 }),
    ]);
  });

  it('evaluates WINDOW rules independently per sensor', async () => {
    await createRule(app, windowAvgRule);
    await send(app, 40, at(0), 'hot-room');
    await send(app, 20, at(0), 'cold-room');
    await send(app, 20, at(1), 'cold-room');
    expect((await alerts()).map((a) => a.sensor_id)).toEqual(['hot-room']);
  });
});
