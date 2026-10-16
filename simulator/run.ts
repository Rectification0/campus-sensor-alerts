// Programmatic simulator runs, shared by the CLI, the E2E test and the load-test harness.

import { ReadingGenerator, type Pattern, type Random, type ReadingJson } from './patterns.js';
import { Sender, Stats, type Mode, type Summary } from './sender.js';

export interface CommonOptions {
  url: string;
  sensors: number;
  types: readonly string[];
  pattern: Pattern;
  mode: Mode;
  batchSize: number;
  connections: number;
  random?: Random;
}

function chunk(readings: ReadingJson[], mode: Mode, batchSize: number): ReadingJson[][] {
  const size = mode === 'single' ? 1 : batchSize;
  const out: ReadingJson[][] = [];
  for (let i = 0; i < readings.length; i += size) out.push(readings.slice(i, i + size));
  return out;
}

/**
 * Sends exactly `count` readings as fast as possible (FR-10.4): all requests are
 * generated up front and dispatched at once; the connection pool bounds concurrency.
 */
export async function runBurst(opts: CommonOptions & { count: number }): Promise<Summary> {
  const generator = new ReadingGenerator(opts);
  const requests = chunk(generator.take(opts.count), opts.mode, opts.batchSize);
  const sender = new Sender(opts.url, opts.connections);
  const stats = new Stats();
  const started = performance.now();
  try {
    await Promise.all(requests.map(async (r) => stats.record(await sender.send(r, opts.mode))));
    return stats.summary(performance.now() - started);
  } finally {
    await sender.close();
  }
}

export interface ContinuousOptions extends CommonOptions {
  rate: number; // readings per second
  durationSeconds: number;
  onProgress?: (p: { elapsedSeconds: number; accepted: number; inFlight: number }) => void;
  signal?: AbortSignal;
}

const TICK_MS = 100;

/**
 * Sends `rate` readings/s for `durationSeconds`. Each tick sends the shortfall against
 * the target schedule; in-flight requests are capped, so if the service is slower than
 * the target the achieved rate (in the summary) drops instead of queueing without bound.
 */
export async function runContinuous(opts: ContinuousOptions): Promise<Summary> {
  const generator = new ReadingGenerator(opts);
  const sender = new Sender(opts.url, opts.connections);
  const stats = new Stats();
  const perRequest = opts.mode === 'single' ? 1 : opts.batchSize;
  const maxInFlight = opts.connections * 2;
  const pending = new Set<Promise<void>>();
  let generated = 0;
  let lastProgress = 0;
  const started = performance.now();
  const total = Math.round(opts.rate * opts.durationSeconds);

  try {
    while (generated < total && !opts.signal?.aborted) {
      const elapsed = (performance.now() - started) / 1000;
      const due = Math.min(total, Math.floor(opts.rate * elapsed));
      while (generated < due && pending.size < maxInFlight) {
        const n = Math.min(perRequest, total - generated);
        const readings = generator.take(n);
        generated += n;
        const p: Promise<void> = sender.send(readings, opts.mode).then((r) => {
          stats.record(r);
          pending.delete(p);
        });
        pending.add(p);
      }
      if (opts.onProgress && elapsed - lastProgress >= 1) {
        lastProgress = Math.floor(elapsed);
        opts.onProgress({
          elapsedSeconds: lastProgress,
          accepted: stats.acceptedSoFar,
          inFlight: pending.size,
        });
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
    await Promise.all(pending);
    return stats.summary(performance.now() - started);
  } finally {
    await sender.close();
  }
}
