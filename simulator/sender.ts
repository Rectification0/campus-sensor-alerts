// HTTP delivery and result statistics for the simulator (design §11).

import { Pool } from 'undici';
import type { ReadingJson } from './patterns.js';

export type Mode = 'single' | 'batch';

export interface SendResult {
  readings: number;
  status: number | null; // null: connection-level error
  accepted: number;
  rejected: number;
  latencyMs: number;
}

/** Keep-alive connection pool to the service. */
export class Sender {
  private readonly pool: Pool;

  constructor(baseUrl: string, connections: number) {
    const url = new URL(baseUrl);
    this.pool = new Pool(url.origin, { connections, pipelining: 1 });
  }

  async send(readings: ReadingJson[], mode: Mode): Promise<SendResult> {
    const started = performance.now();
    try {
      const res = await this.pool.request({
        method: 'POST',
        path: mode === 'single' ? '/api/v1/readings' : '/api/v1/readings/batch',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mode === 'single' ? readings[0] : readings),
      });
      const body = (await res.body.json().catch(() => ({}))) as {
        accepted?: number;
        rejected?: unknown[];
      };
      const accepted = res.statusCode === 202 ? (body.accepted ?? 0) : 0;
      return {
        readings: readings.length,
        status: res.statusCode,
        accepted,
        rejected: readings.length - accepted,
        latencyMs: performance.now() - started,
      };
    } catch {
      return {
        readings: readings.length,
        status: null,
        accepted: 0,
        rejected: readings.length,
        latencyMs: performance.now() - started,
      };
    }
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}

export interface Summary {
  requests: number;
  readingsSent: number;
  accepted: number;
  rejected: number;
  statusCounts: Record<string, number>; // "202", "503", ..., "error"
  errors: number; // connection-level failures
  durationMs: number;
  readingsPerSecond: number; // accepted readings / duration
  latencyMs: { min: number; p50: number; p95: number; p99: number; max: number; mean: number };
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

const round = (n: number) => Math.round(n * 10) / 10;

export class Stats {
  private readonly latencies: number[] = [];
  private requests = 0;
  private readingsSent = 0;
  private accepted = 0;
  private rejected = 0;
  private readonly statusCounts: Record<string, number> = {};

  record(r: SendResult): void {
    this.requests++;
    this.readingsSent += r.readings;
    this.accepted += r.accepted;
    this.rejected += r.rejected;
    const key = r.status === null ? 'error' : String(r.status);
    this.statusCounts[key] = (this.statusCounts[key] ?? 0) + 1;
    this.latencies.push(r.latencyMs);
  }

  get acceptedSoFar(): number {
    return this.accepted;
  }

  summary(durationMs: number): Summary {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    return {
      requests: this.requests,
      readingsSent: this.readingsSent,
      accepted: this.accepted,
      rejected: this.rejected,
      statusCounts: { ...this.statusCounts },
      errors: this.statusCounts.error ?? 0,
      durationMs: round(durationMs),
      readingsPerSecond: durationMs > 0 ? Math.round((this.accepted / durationMs) * 1000) : 0,
      latencyMs: {
        min: round(sorted[0] ?? 0),
        p50: round(percentile(sorted, 50)),
        p95: round(percentile(sorted, 95)),
        p99: round(percentile(sorted, 99)),
        max: round(sorted[sorted.length - 1] ?? 0),
        mean: round(mean),
      },
    };
  }
}
