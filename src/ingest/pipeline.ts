// Group-commit ingestion (design §2, §7.2): requests queue their readings and wait;
// the flusher drains many requests per transaction and answers each one after COMMIT.

import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { serviceUnavailable } from '../common/errors.js';
import type { RuleEngine } from '../engine/engine.js';
import type { AlertUpsert, Reading } from '../engine/evaluator.js';
import { IngestBuffer, type PendingRequest } from './buffer.js';
import { commitBatch } from './repository.js';

export interface PipelineOptions {
  pool: pg.Pool;
  engine: RuleEngine;
  log: FastifyBaseLogger;
  bufferCapacity: number;
  flushIntervalMs: number;
  flushMaxRows: number;
  flushConcurrency: number;
  commitRetryBudgetMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IngestPipeline {
  private readonly buffer: IngestBuffer;
  private readonly inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly opts: PipelineOptions) {
    this.buffer = new IngestBuffer(opts.bufferCapacity);
  }

  /**
   * Resolves once all readings are committed together with their alert changes (FR-1.1).
   * Rejects with 503 if the buffer is full or the commit fails; nothing is stored then (FR-3.3).
   */
  submit(readings: Reading[]): Promise<void> {
    if (this.closed) return Promise.reject(serviceUnavailable('Service is shutting down'));
    return new Promise<void>((resolve, reject) => {
      if (!this.buffer.push({ readings, resolve, reject })) {
        reject(serviceUnavailable('Ingest buffer is full, retry shortly'));
        return;
      }
      this.schedule();
    });
  }

  /** Readings waiting for a transaction. */
  get depth(): number {
    return this.buffer.depth;
  }

  /** Stops accepting, then waits until everything queued has been committed or rejected. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flushAll();
  }

  /** Flushes everything now, ignoring the interval timer (used by close and tests). */
  async flushAll(): Promise<void> {
    while (this.buffer.depth > 0 || this.inFlight.size > 0) {
      this.kick();
      if (this.inFlight.size) await Promise.race(this.inFlight);
    }
  }

  private schedule(): void {
    if (this.buffer.depth >= this.opts.flushMaxRows) {
      this.kick();
    } else if (this.buffer.depth > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.kick();
      }, this.opts.flushIntervalMs);
    }
  }

  private kick(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.inFlight.size < this.opts.flushConcurrency && this.buffer.depth > 0) {
      const requests = this.buffer.drain(this.opts.flushMaxRows);
      const flush = this.flush(requests).finally(() => {
        this.inFlight.delete(flush);
        this.schedule();
      });
      this.inFlight.add(flush);
    }
  }

  private async flush(requests: PendingRequest[]): Promise<void> {
    const readings = requests.flatMap((r) => r.readings);
    const started = performance.now();
    // Evaluate synchronously at drain time so window state sees batches in order,
    // even though their commits may overlap.
    let evaluation;
    try {
      evaluation = this.opts.engine.evaluate(readings);
    } catch (err) {
      this.opts.log.error({ err }, 'rule evaluation failed');
      for (const r of requests) r.reject(serviceUnavailable('Rule evaluation failed'));
      return;
    }
    if (evaluation.lateReadings) {
      this.opts.log.debug(
        { late: evaluation.lateReadings },
        'late readings skipped by window rules',
      );
    }

    const evaluated = performance.now();
    try {
      const result = await this.commitWithRetry(readings, evaluation.alerts);
      for (const r of requests) r.resolve();
      this.opts.log.debug(
        {
          readings: readings.length,
          requests: requests.length,
          alertRows: evaluation.alerts.length,
          evaluateMs: Math.round(evaluated - started),
          commitMs: Math.round(performance.now() - evaluated),
          queued: this.buffer.depth,
        },
        'batch committed',
      );
      if (result.alertsCreated) {
        this.opts.log.info({ alertsCreated: result.alertsCreated }, 'alerts created');
      }
    } catch (err) {
      this.opts.log.error({ err, readings: readings.length }, 'batch commit failed; rejecting');
      for (const r of requests) r.reject(serviceUnavailable('Could not store readings, retry'));
      // Window state already includes these never-stored readings: rebuild it from the DB.
      const types = new Set(readings.map((r) => r.type));
      await this.opts.engine.rewarmTypes(types).catch((rewarmErr: unknown) => {
        this.opts.log.error({ err: rewarmErr }, 'window rebuild after failed commit failed');
      });
    }
  }

  /** Retries the same prepared rows (no re-evaluation) with backoff, within the budget. */
  private async commitWithRetry(readings: readonly Reading[], alerts: readonly AlertUpsert[]) {
    const deadline = Date.now() + this.opts.commitRetryBudgetMs;
    let delay = 50;
    for (;;) {
      try {
        return await commitBatch(this.opts.pool, readings, alerts);
      } catch (err) {
        if (Date.now() + delay > deadline) throw err;
        this.opts.log.warn({ err, retryInMs: delay }, 'batch commit failed; retrying');
        await sleep(delay);
        delay = Math.min(delay * 2, 1000);
      }
    }
  }
}
