import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from '../helpers/app.js';
import { resetTestDb, testDbUrl } from '../helpers/db.js';

const UNKNOWN_ID = '0190a6e2-0000-7000-8000-000000000000';

describe.skipIf(!testDbUrl)('alerts API (FR-8, FR-9)', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof makeApp>['app'];

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDbUrl });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDb();
    app = makeApp(pool).app;
    await app.inject({
      method: 'POST',
      url: '/api/v1/rules',
      payload: { kind: 'THRESHOLD', type: 'temperature', operator: 'gt', threshold: 30 },
    });
  });

  /** Produces alerts through the real ingestion path; returns them oldest first. */
  async function raiseAlerts(sensorIds: string[], value = 34.5) {
    for (const sensorId of sensorIds) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/readings',
        payload: { sensorId, type: 'temperature', value, timestamp: new Date().toISOString() },
      });
      expect(res.statusCode).toBe(202);
    }
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM alerts ORDER BY id');
    return rows.map((r) => r.id);
  }

  const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}` });
  const act = (id: string, action: 'acknowledge' | 'resolve') =>
    app.inject({ method: 'POST', url: `/api/v1/alerts/${id}/${action}` });

  describe('viewing', () => {
    it('lists alerts newest first with their details', async () => {
      const [first, second] = await raiseAlerts(['library-floor-2', 'lab']);
      const res = await get('/alerts');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.nextCursor).toBeNull();
      expect(body.items.map((a: { id: string }) => a.id)).toEqual([second, first]);
      expect(body.items[1]).toMatchObject({
        id: first,
        sensorId: 'library-floor-2',
        type: 'temperature',
        status: 'OPEN',
        triggerValue: 34.5,
        lastValue: 34.5,
        triggerCount: 1,
        windowStart: null,
        windowEnd: null,
        acknowledgedAt: null,
        resolvedAt: null,
      });
      expect(Date.parse(body.items[1].firstTriggeredAt)).not.toBeNaN();
    });

    it('paginates with limit and cursor (FR-8.1)', async () => {
      const ids = await raiseAlerts(['s1', 's2', 's3', 's4', 's5']);
      const newestFirst = [...ids].reverse();

      const page1 = (await get('/alerts?limit=2')).json();
      expect(page1.items.map((a: { id: string }) => a.id)).toEqual(newestFirst.slice(0, 2));
      const page2 = (await get(`/alerts?limit=2&cursor=${page1.nextCursor}`)).json();
      expect(page2.items.map((a: { id: string }) => a.id)).toEqual(newestFirst.slice(2, 4));
      const page3 = (await get(`/alerts?limit=2&cursor=${page2.nextCursor}`)).json();
      expect(page3.items.map((a: { id: string }) => a.id)).toEqual(newestFirst.slice(4));
      expect(page3.nextCursor).toBeNull();
    });

    it('validates pagination parameters', async () => {
      expect((await get('/alerts?limit=0')).statusCode).toBe(400);
      expect((await get('/alerts?limit=201')).statusCode).toBe(400);
      expect((await get('/alerts?limit=abc')).statusCode).toBe(400);
      expect((await get('/alerts?cursor=nope')).statusCode).toBe(400);
      expect((await get('/alerts?status=OPEN')).statusCode).toBe(400);
      expect((await get('/alerts?limit=200')).statusCode).toBe(200);
    });

    it('gets one alert, 404 for unknown ids, 400 for malformed ids (FR-8.2)', async () => {
      const [id] = await raiseAlerts(['lab']);
      const res = await get(`/alerts/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(id);
      expect((await get(`/alerts/${UNKNOWN_ID}`)).statusCode).toBe(404);
      expect((await get('/alerts/123')).statusCode).toBe(400);
    });
  });

  describe('lifecycle', () => {
    it('OPEN -> ACKNOWLEDGED -> RESOLVED (FR-9.1, FR-9.2)', async () => {
      const [id] = await raiseAlerts(['lab']);
      const acked = await act(id!, 'acknowledge');
      expect(acked.statusCode).toBe(200);
      expect(acked.json()).toMatchObject({ status: 'ACKNOWLEDGED', resolvedAt: null });
      expect(acked.json().acknowledgedAt).not.toBeNull();

      const resolved = await act(id!, 'resolve');
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({
        status: 'RESOLVED',
        acknowledgedAt: acked.json().acknowledgedAt,
      });
      expect(resolved.json().resolvedAt).not.toBeNull();
    });

    it('OPEN -> RESOLVED directly', async () => {
      const [id] = await raiseAlerts(['lab']);
      const res = await act(id!, 'resolve');
      expect(res.json()).toMatchObject({ status: 'RESOLVED', acknowledgedAt: null });
    });

    it('repeating an applied transition is idempotent (FR-9.3)', async () => {
      const [id] = await raiseAlerts(['lab']);
      const first = (await act(id!, 'acknowledge')).json();
      const again = await act(id!, 'acknowledge');
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first);

      const resolved = (await act(id!, 'resolve')).json();
      const resolvedAgain = await act(id!, 'resolve');
      expect(resolvedAgain.statusCode).toBe(200);
      expect(resolvedAgain.json()).toEqual(resolved);
    });

    it('acknowledging a RESOLVED alert is 409; unknown ids are 404 (FR-9.4)', async () => {
      const [id] = await raiseAlerts(['lab']);
      await act(id!, 'resolve');
      const res = await act(id!, 'acknowledge');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ statusCode: 409, error: 'Conflict' });
      expect((await get(`/alerts/${id}`)).json().status).toBe('RESOLVED');

      expect((await act(UNKNOWN_ID, 'acknowledge')).statusCode).toBe(404);
      expect((await act(UNKNOWN_ID, 'resolve')).statusCode).toBe(404);
    });

    it('re-triggers keep an ACKNOWLEDGED alert active; resolve lets a new alert open', async () => {
      const [id] = await raiseAlerts(['lab']);
      await act(id!, 'acknowledge');
      const ids = await raiseAlerts(['lab'], 40);
      expect(ids).toEqual([id]);
      expect((await get(`/alerts/${id}`)).json()).toMatchObject({
        status: 'ACKNOWLEDGED',
        triggerCount: 2,
        lastValue: 40,
      });

      await act(id!, 'resolve');
      const after = await raiseAlerts(['lab'], 41);
      expect(after).toHaveLength(2);
      expect((await get(`/alerts/${after[1]}`)).json()).toMatchObject({
        status: 'OPEN',
        triggerCount: 1,
        triggerValue: 41,
      });
    });

    it('concurrent transitions stay consistent (NFR-5)', async () => {
      const [id] = await raiseAlerts(['lab']);
      const results = await Promise.all([
        ...Array.from({ length: 5 }, () => act(id!, 'acknowledge')),
        ...Array.from({ length: 5 }, () => act(id!, 'resolve')),
      ]);
      // Acknowledges that lose the race to a resolve get 409; nothing else fails.
      for (const r of results) expect([200, 409]).toContain(r.statusCode);
      expect(results.slice(5).every((r) => r.statusCode === 200)).toBe(true);
      const final = (await get(`/alerts/${id}`)).json();
      expect(final.status).toBe('RESOLVED');
      const resolvedAts = new Set(results.slice(5).map((r) => r.json().resolvedAt));
      expect(resolvedAts.size).toBe(1);
    });
  });
});
