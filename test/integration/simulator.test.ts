// T6.4 E2E smoke: a real HTTP server on the test DB, driven by the simulator.

import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seededRandom } from '../../simulator/patterns.js';
import { runBurst, runContinuous } from '../../simulator/run.js';
import { makeApp } from '../helpers/app.js';
import { resetTestDb, testDbUrl } from '../helpers/db.js';

describe.skipIf(!testDbUrl)('simulator against a live server', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof makeApp>['app'];
  let url: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDbUrl });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetTestDb();
    app = makeApp(pool).app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    return () => app.close();
  });

  const count = async (sql: string) => (await pool.query(sql)).rows[0].n as number;

  it('spike pattern triggers THRESHOLD alerts (FR-10.3)', async () => {
    for (const [type, threshold] of [
      ['temperature', 30],
      ['humidity', 70],
      ['co2', 1000],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/rules',
        payload: { kind: 'THRESHOLD', type, operator: 'gt', threshold },
      });
    }
    const summary = await runContinuous({
      url,
      sensors: 10,
      types: ['temperature', 'humidity', 'co2'],
      pattern: 'spike',
      mode: 'batch',
      batchSize: 50,
      connections: 4,
      rate: 1000,
      durationSeconds: 1,
      random: seededRandom(11),
    });
    expect(summary).toMatchObject({ readingsSent: 1000, accepted: 1000, errors: 0 });
    expect(summary.statusCounts).toEqual({ '202': 20 });
    expect(await count('SELECT count(*)::int AS n FROM readings')).toBe(1000);
    expect(await count('SELECT count(*)::int AS n FROM alerts')).toBeGreaterThan(0);
  });

  it('burst mode sends exactly N readings, single or batch (FR-10.4)', async () => {
    const common = {
      url,
      sensors: 20,
      types: ['temperature'],
      pattern: 'normal' as const,
      batchSize: 100,
      connections: 16,
      random: seededRandom(5),
    };
    const batch = await runBurst({ ...common, mode: 'batch', count: 1000 });
    expect(batch).toMatchObject({ requests: 10, readingsSent: 1000, accepted: 1000, errors: 0 });
    const single = await runBurst({ ...common, mode: 'single', count: 200 });
    expect(single).toMatchObject({ requests: 200, accepted: 200, errors: 0 });
    expect(single.latencyMs.p99).toBeGreaterThan(0);
    expect(await count('SELECT count(*)::int AS n FROM readings')).toBe(1200);
  });

  it('reports 503s and connection errors instead of throwing', async () => {
    const tiny = makeApp(pool, { BUFFER_CAPACITY: '50' }).app;
    await tiny.listen({ port: 0, host: '127.0.0.1' });
    const tinyUrl = `http://127.0.0.1:${(tiny.server.address() as AddressInfo).port}`;
    const common = {
      sensors: 5,
      types: ['temperature'],
      pattern: 'normal' as const,
      mode: 'batch' as const,
      batchSize: 100, // larger than the buffer: always 503
      connections: 2,
      count: 200,
    };
    const full = await runBurst({ ...common, url: tinyUrl });
    expect(full).toMatchObject({ accepted: 0, rejected: 200, statusCounts: { '503': 2 } });
    await tiny.close();

    const down = await runBurst({ ...common, url: tinyUrl });
    expect(down).toMatchObject({ accepted: 0, errors: 2 });
  });
});
