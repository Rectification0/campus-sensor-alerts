// T7.2 load-test harness (FR-11, specs §7).
//
//   pnpm loadtest [--runs 3] [--scenarios A,B,C] [--single-connections 512] [--port 3100]
//
// 1. Recreates a dedicated database (LOADTEST_DATABASE_URL, default: DATABASE_URL with the
//    database name campus_sensors_loadtest) so the main database is never touched.
// 2. Starts the production build (dist/server.js) with request logging off, preloading
//    loadtest/probe.mjs, which reports the server's CPU, event-loop and memory use over IPC.
// 3. Seeds 24 rules, warms the server up, then runs each scenario `runs` times:
//    10,000 readings from 200 sensors x 3 types, fired as fast as the client can.
// 4. Per run: latency percentiles, completion time, status counts, server usage, and a
//    DB check that rows added == readings accepted.
// 5. Writes docs/load-test-results.json and the generated part of docs/LOAD_TEST_REPORT.md.
//
// Diagnostics: LOADTEST_SERVER_LOG=<file> saves the server log (LOG_LEVEL=debug adds per-batch
// timings); LOADTEST_SERVER_NODE_ARGS passes extra Node flags to the server (e.g. --trace-gc).
// Server knobs (FLUSH_MAX_ROWS, FLUSH_INTERVAL_MS, FLUSH_CONCURRENCY, PG_POOL_MAX, ...) are
// passed through from the environment, for tuning experiments.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { ensureDatabase } from '../scripts/db-admin.js';
import { runBurst } from '../simulator/run.js';
import type { Summary } from '../simulator/sender.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import {
  evaluateRun,
  writeReport,
  type LoadTestData,
  type RunResult,
  type Scenario,
  type ServerUsage,
} from './report.js';
import { seedRules } from './seed-rules.js';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    scenarios: { type: 'string', default: 'A,B,C' },
    'single-connections': { type: 'string', default: '512' },
    port: { type: 'string', default: '3100' },
    'no-report': { type: 'boolean', default: false },
  },
});

const READINGS = 10_000;
const SENSORS = 200;
const TYPES = ['temperature', 'humidity', 'co2'];
const RUNS = Number(values.runs);

const SCENARIOS: Record<string, Scenario> = {
  A: {
    id: 'LT-A',
    title: '10 batch requests x 1000 readings',
    mode: 'batch',
    batchSize: 1000,
    connections: 10,
  },
  B: {
    id: 'LT-B',
    title: '100 batch requests x 100 readings',
    mode: 'batch',
    batchSize: 100,
    connections: 100,
  },
  C: {
    id: 'LT-C',
    title: '10,000 single-reading requests',
    mode: 'single',
    batchSize: 1,
    connections: Number(values['single-connections']),
  },
};

const log = (msg: string) => console.log(`[loadtest] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadTestDbUrl(): string {
  if (process.env.LOADTEST_DATABASE_URL) return process.env.LOADTEST_DATABASE_URL;
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL or LOADTEST_DATABASE_URL');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/campus_sensors_loadtest';
  return url.toString();
}

async function startServer(env: NodeJS.ProcessEnv, baseUrl: string): Promise<ChildProcess> {
  if (!existsSync('dist/server.js')) throw new Error('dist/server.js missing: run "pnpm build"');
  const nodeArgs = (process.env.LOADTEST_SERVER_NODE_ARGS ?? '').split(' ').filter(Boolean);
  // Environment variables take precedence over --env-file, so the overrides win.
  const child = spawn(
    process.execPath,
    [
      ...nodeArgs,
      '--env-file-if-exists=.env',
      '--import',
      './loadtest/probe.mjs',
      'dist/server.js',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  if (process.env.LOADTEST_SERVER_LOG) {
    const file = createWriteStream(process.env.LOADTEST_SERVER_LOG);
    child.stdout!.pipe(file);
    child.stderr!.pipe(file);
  }
  child.on('exit', (code) => {
    if (code) console.error(`[server] exited with ${code}\n${output}`);
  });

  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(new URL('/api/v1/rules', baseUrl))).ok) return child;
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  child.kill();
  throw new Error(`Server did not become ready:\n${output}`);
}

/** Asks the in-server probe (loadtest/probe.mjs) to start or stop a measurement window. */
function probe(server: ChildProcess, command: 'probe:start'): Promise<void>;
function probe(server: ChildProcess, command: 'probe:stop'): Promise<ServerUsage>;
function probe(server: ChildProcess, command: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const expected = command === 'probe:start' ? 'probe:started' : 'probe:result';
    const timer = setTimeout(() => reject(new Error(`probe did not answer ${command}`)), 5000);
    const onMessage = (msg: { type?: string } & Record<string, unknown>) => {
      if (msg?.type !== expected) return;
      clearTimeout(timer);
      server.off('message', onMessage);
      const { type: _type, ...usage } = msg;
      resolve(usage);
    };
    server.on('message', onMessage);
    server.send(command);
  });
}

async function main() {
  const runtimeUrl = loadTestDbUrl();
  const port = values.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  log(`database: ${new URL(runtimeUrl).pathname.slice(1)} (recreated)`);
  await ensureDatabase(runtimeUrl, { reset: true, log: () => {} });
  await migrate(runtimeUrl);
  const db = new pg.Pool({ connectionString: runtimeUrl, max: 2 });

  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: runtimeUrl,
    PORT: port,
    REQUEST_LOGGING: 'false',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  };
  const serverConfig = loadConfig(serverEnv);
  log(`starting dist/server.js on :${port}`);
  const server = await startServer(serverEnv, baseUrl);

  try {
    const ruleCount = await seedRules(baseUrl);
    log(`seeded ${ruleCount} rules`);

    const common = { url: baseUrl, sensors: SENSORS, types: TYPES, pattern: 'normal' as const };
    log('warm-up (excluded from results)');
    await runBurst({ ...common, mode: 'batch', batchSize: 100, connections: 20, count: 5000 });
    await runBurst({ ...common, mode: 'single', batchSize: 1, connections: 200, count: 2000 });
    await sleep(1000);

    const count = async () => {
      const { rows } = await db.query<{ readings: number; triggers: number }>(
        `SELECT (SELECT count(*)::int FROM readings) AS readings,
                (SELECT coalesce(sum(trigger_count), 0)::int FROM alerts) AS triggers`,
      );
      return rows[0]!;
    };

    const results: RunResult[] = [];
    for (const key of values.scenarios.split(',').map((s) => s.trim().toUpperCase())) {
      const scenario = SCENARIOS[key];
      if (!scenario) throw new Error(`Unknown scenario ${key}`);
      for (let run = 1; run <= RUNS; run++) {
        const before = await count();
        await probe(server, 'probe:start');
        const summary: Summary = await runBurst({
          ...common,
          mode: scenario.mode,
          batchSize: scenario.batchSize,
          connections: scenario.connections,
          count: READINGS,
        });
        const usage = await probe(server, 'probe:stop');
        const after = await count();
        const result = evaluateRun(
          {
            scenario: scenario.id,
            run,
            summary,
            rowsAdded: after.readings - before.readings,
            alertTriggersAdded: after.triggers - before.triggers,
            server: usage,
          },
          scenario,
        );
        results.push(result);
        log(
          `${scenario.id} run ${run}: ${summary.accepted}/${READINGS} accepted, ` +
            `done in ${summary.durationMs} ms, p99 ${summary.latencyMs.p99} ms, ` +
            `rows +${result.rowsAdded}, cpu ${usage.avgCpuPercent}%, ` +
            `event loop ${usage.eventLoopUtilizationPercent}% busy ` +
            `-> ${result.pass ? 'PASS' : `FAIL (${result.failures.join('; ')})`}`,
        );
        await sleep(1000);
      }
    }

    const { rows: pgRows } = await db.query<{ version: string }>('SELECT version()');
    const data: LoadTestData = {
      generatedAt: new Date().toISOString(),
      command: `pnpm loadtest ${process.argv.slice(2).join(' ')}`.trim(),
      machine: {
        cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
        logicalCores: os.cpus().length,
        memoryGb: Math.round(os.totalmem() / 1024 ** 3),
        os: `${os.type()} ${os.release()} (${os.arch()})`,
        node: process.version,
        postgres: pgRows[0]!.version.split(',')[0]!,
      },
      setup: {
        readingsPerBurst: READINGS,
        sensors: SENSORS,
        types: TYPES,
        rules: ruleCount,
        runsPerScenario: RUNS,
        server: {
          FLUSH_MAX_ROWS: serverConfig.flushMaxRows,
          FLUSH_INTERVAL_MS: serverConfig.flushIntervalMs,
          FLUSH_CONCURRENCY: serverConfig.flushConcurrency,
          PG_POOL_MAX: serverConfig.pgPoolMax,
          BUFFER_CAPACITY: serverConfig.bufferCapacity,
        },
      },
      scenarios: Object.values(SCENARIOS).filter((s) => results.some((r) => r.scenario === s.id)),
      results,
    };

    const allPass = results.every((r) => r.pass);
    if (!values['no-report']) {
      await mkdir('docs', { recursive: true });
      await writeFile('docs/load-test-results.json', JSON.stringify(data, null, 2) + '\n');
      await writeReport('docs/LOAD_TEST_REPORT.md', data);
      log('wrote docs/LOAD_TEST_REPORT.md and docs/load-test-results.json');
    }
    log(allPass ? 'ALL SCENARIOS PASS' : 'SOME RUNS FAILED');
    process.exitCode = allPass ? 0 : 1;
  } finally {
    server.kill();
    await db.end();
  }
}

await main();
