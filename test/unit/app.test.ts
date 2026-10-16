import { Type } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { RuleEngine } from '../../src/engine/engine.js';

function testApp() {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    BODY_LIMIT_BYTES: '64',
  });
  const pool = {} as pg.Pool;
  const app = buildApp({ config, pool, engine: new RuleEngine(pool) });
  app.post('/echo', { schema: { body: Type.Object({ value: Type.Number() }) } }, (req) => req.body);
  app.get('/boom', () => {
    throw new Error('secret detail');
  });
  return app;
}

describe('buildApp error handling', () => {
  it('returns 400 with per-field errors on validation failure', async () => {
    const app = testApp();
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { value: 'x' } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(body.errors).toEqual([{ path: '/value', message: expect.any(String) }]);
  });

  it('returns 413 when the body exceeds the limit', async () => {
    const app = testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { value: 1, pad: 'x'.repeat(200) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('hides internal error details on 500', async () => {
    const app = testApp();
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toBe('Internal Server Error');
  });
});
