import type { Reading } from '../engine/evaluator.js';

/** One HTTP request's valid readings, waiting for the transaction that stores them. */
export interface PendingRequest {
  readings: Reading[];
  resolve(): void;
  reject(err: Error): void;
}

/**
 * Bounded FIFO of pending requests (design §7.1). Capacity is counted in readings.
 * Requests are never split, so each request's readings commit in exactly one transaction:
 * a request either fully succeeds (202) or fully fails (503).
 */
export class IngestBuffer {
  private queue: PendingRequest[] = [];
  private head = 0;
  private readings = 0;

  constructor(readonly capacity: number) {}

  /** All-or-nothing: returns false if the request does not fit. */
  push(request: PendingRequest): boolean {
    if (this.readings + request.readings.length > this.capacity) return false;
    this.queue.push(request);
    this.readings += request.readings.length;
    return true;
  }

  /**
   * Takes whole requests from the front totalling at most maxReadings
   * (but always at least one request, however large).
   */
  drain(maxReadings: number): PendingRequest[] {
    const taken: PendingRequest[] = [];
    let total = 0;
    while (this.head < this.queue.length) {
      const next = this.queue[this.head]!;
      if (taken.length && total + next.readings.length > maxReadings) break;
      taken.push(next);
      total += next.readings.length;
      this.head++;
    }
    this.readings -= total;
    if (this.head === this.queue.length) {
      this.queue = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return taken;
  }

  /** Number of readings waiting. */
  get depth(): number {
    return this.readings;
  }
}
