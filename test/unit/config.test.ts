import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.flushMaxRows).toBe(2000);
    expect(c.batchMaxItems).toBe(1000);
    expect(c.requestLogging).toBe(true);
    expect(c.testDatabaseUrl).toBeUndefined();
  });

  it('parses overrides', () => {
    const c = loadConfig({
      ...base,
      PORT: '8080',
      REQUEST_LOGGING: 'false',
      FLUSH_MAX_ROWS: '500',
    });
    expect(c.port).toBe(8080);
    expect(c.requestLogging).toBe(false);
    expect(c.flushMaxRows).toBe(500);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects invalid numbers and booleans', () => {
    expect(() => loadConfig({ ...base, FLUSH_MAX_ROWS: 'abc' })).toThrow(/FLUSH_MAX_ROWS/);
    expect(() => loadConfig({ ...base, FLUSH_MAX_ROWS: '0' })).toThrow(/FLUSH_MAX_ROWS/);
    expect(() => loadConfig({ ...base, REQUEST_LOGGING: 'maybe' })).toThrow(/REQUEST_LOGGING/);
  });
});
