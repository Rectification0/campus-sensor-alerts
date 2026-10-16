// Sensor simulator CLI (FR-10).
//
//   pnpm sim --sensors 50 --rate 200 --duration 30 --pattern spike
//   pnpm sim --burst 10000 --mode batch --batch-size 1000
//   pnpm sim --help

import { parseArgs } from 'node:util';
import { PATTERNS, type Pattern } from './patterns.js';
import { runBurst, runContinuous, type CommonOptions } from './run.js';
import type { Summary } from './sender.js';

const HELP = `Campus sensor simulator

Usage: pnpm sim [options]

  --url <url>           Service base URL (default http://127.0.0.1:3000)
  --sensors <n>         Number of sensors (default 20)
  --types <list>        Comma-separated metric types (default temperature,humidity,co2)
  --pattern <p>         normal | spike | drift (default normal)
  --mode <m>            single | batch (default batch)
  --batch-size <n>      Readings per batch request, 1-1000 (default 100)
  --connections <n>     Concurrent HTTP connections (default 64)

Continuous mode (default):
  --rate <n>            Readings per second (default 100)
  --duration <s>        Seconds to run (default 10)

Burst mode:
  --burst <n>           Send exactly n readings as fast as possible, then report

Output:
  --json                Print only the JSON summary
  --help                Show this help`;

function fail(message: string): never {
  console.error(`Error: ${message}\n\nRun "pnpm sim --help" for usage.`);
  process.exit(2);
}

function positiveInt(name: string, raw: string | undefined, fallback: number, max = Infinity) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    fail(`--${name} must be ${max === Infinity ? 'a positive integer' : `an integer 1-${max}`}`);
  }
  return n;
}

function parseCli() {
  try {
    return parseArgs({
      options: {
        url: { type: 'string', default: 'http://127.0.0.1:3000' },
        sensors: { type: 'string' },
        types: { type: 'string', default: 'temperature,humidity,co2' },
        pattern: { type: 'string', default: 'normal' },
        mode: { type: 'string', default: 'batch' },
        'batch-size': { type: 'string' },
        connections: { type: 'string' },
        rate: { type: 'string' },
        duration: { type: 'string' },
        burst: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });
  } catch (err) {
    fail((err as Error).message);
  }
}

const { values } = parseCli();

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

if (!PATTERNS.includes(values.pattern as Pattern)) fail('--pattern must be normal, spike or drift');
if (values.mode !== 'single' && values.mode !== 'batch') fail('--mode must be single or batch');
const types = values.types
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
if (!types.length) fail('--types must list at least one type');
try {
  new URL(values.url);
} catch {
  fail('--url must be a valid URL');
}

const common: CommonOptions = {
  url: values.url,
  sensors: positiveInt('sensors', values.sensors, 20),
  types,
  pattern: values.pattern as Pattern,
  mode: values.mode,
  batchSize: positiveInt('batch-size', values['batch-size'], 100, 1000),
  connections: positiveInt('connections', values.connections, 64),
};

function print(title: string, summary: Summary) {
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const l = summary.latencyMs;
  console.log(`\n${title}`);
  console.table({
    'requests sent': summary.requests,
    'readings sent': summary.readingsSent,
    'readings accepted': summary.accepted,
    'readings rejected': summary.rejected,
    'connection errors': summary.errors,
    'duration (ms)': summary.durationMs,
    'accepted readings/s': summary.readingsPerSecond,
  });
  console.log('HTTP status counts:', summary.statusCounts);
  console.log(
    `Request latency (ms): min ${l.min} | p50 ${l.p50} | p95 ${l.p95} | p99 ${l.p99} | max ${l.max} | mean ${l.mean}`,
  );
}

if (values.burst !== undefined) {
  const count = positiveInt('burst', values.burst, 0);
  if (!values.json) {
    console.log(
      `Burst: ${count} readings as ${common.mode} requests` +
        (common.mode === 'batch' ? ` of ${common.batchSize}` : '') +
        ` to ${common.url} ...`,
    );
  }
  print('Burst summary', await runBurst({ ...common, count }));
} else {
  const rate = positiveInt('rate', values.rate, 100);
  const durationSeconds = positiveInt('duration', values.duration, 10);
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  if (!values.json) {
    console.log(
      `Sending ~${rate} readings/s for ${durationSeconds}s from ${common.sensors} sensors ` +
        `(${types.join(', ')}), pattern ${common.pattern}, ${common.mode} mode. Ctrl+C stops early.`,
    );
  }
  const summary = await runContinuous({
    ...common,
    rate,
    durationSeconds,
    signal: abort.signal,
    onProgress: values.json
      ? undefined
      : (p) =>
          console.log(`  ${p.elapsedSeconds}s: ${p.accepted} accepted, ${p.inFlight} in flight`),
  });
  print('Run summary', summary);
}
