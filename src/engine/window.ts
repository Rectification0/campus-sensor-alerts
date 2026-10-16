// Sliding event-time windows (FR-6, design §7.4).

import type { Aggregation } from '../rules/schemas.js';

interface Sample {
  ts: number; // epoch ms
  value: number;
}

/** Array-backed FIFO with O(1) amortised push/shift/popBack. */
class Deque<T> {
  private items: T[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }
  front(): T | undefined {
    return this.items[this.head];
  }
  back(): T | undefined {
    return this.items[this.items.length - 1];
  }
  push(item: T): void {
    this.items.push(item);
  }
  popBack(): void {
    this.items.pop();
  }
  shift(): void {
    this.head++;
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
  *[Symbol.iterator](): Iterator<T> {
    for (let i = this.head; i < this.items.length; i++) yield this.items[i]!;
  }
}

export interface WindowSnapshot {
  count: number;
  avg: number;
  min: number;
  max: number;
  windowStart: number; // ts of the oldest sample in the window
  windowEnd: number; // ts of the newest sample
}

export function aggregate(snapshot: WindowSnapshot, agg: Aggregation): number {
  return snapshot[agg];
}

// Recompute the running sum from scratch this often to stop floating-point drift.
const RESUM_EVERY = 100_000;

/**
 * Readings of one sensor for one WINDOW rule, covering (latestTs - windowMs, latestTs].
 * avg uses a running sum; min/max use monotonic deques, so add() is O(1) amortised.
 */
export class SlidingWindow {
  private readonly samples = new Deque<Sample>();
  private readonly minQ = new Deque<Sample>(); // values non-decreasing front to back
  private readonly maxQ = new Deque<Sample>(); // values non-increasing front to back
  private sum = 0;
  private opsSinceResum = 0;
  private latestTs = -Infinity;
  lastTouched = 0; // wall-clock ms, for idle sweeping

  constructor(readonly windowMs: number) {}

  /** Adds a sample; returns undefined (and ignores it) if it is older than the newest one seen. */
  add(ts: number, value: number, now = Date.now()): WindowSnapshot | undefined {
    if (ts < this.latestTs) return undefined; // late reading (FR-6.4)
    this.latestTs = ts;
    this.lastTouched = now;

    const sample = { ts, value };
    this.samples.push(sample);
    this.sum += value;
    while (this.minQ.length && this.minQ.back()!.value > value) this.minQ.popBack();
    this.minQ.push(sample);
    while (this.maxQ.length && this.maxQ.back()!.value < value) this.maxQ.popBack();
    this.maxQ.push(sample);

    const cutoff = ts - this.windowMs; // window is (cutoff, ts]
    while (this.samples.front()!.ts <= cutoff) {
      this.sum -= this.samples.front()!.value;
      this.samples.shift();
    }
    while (this.minQ.front()!.ts <= cutoff) this.minQ.shift();
    while (this.maxQ.front()!.ts <= cutoff) this.maxQ.shift();

    if (++this.opsSinceResum >= RESUM_EVERY) {
      this.opsSinceResum = 0;
      this.sum = 0;
      for (const s of this.samples) this.sum += s.value;
    }

    const count = this.samples.length;
    return {
      count,
      avg: this.sum / count,
      min: this.minQ.front()!.value,
      max: this.maxQ.front()!.value,
      windowStart: this.samples.front()!.ts,
      windowEnd: ts,
    };
  }

  get size(): number {
    return this.samples.length;
  }
}

/** All sliding windows, keyed by rule id then sensor id. */
export class WindowStore {
  private readonly byRule = new Map<string, Map<string, SlidingWindow>>();

  add(
    ruleId: string,
    windowSeconds: number,
    sensorId: string,
    ts: number,
    value: number,
    now = Date.now(),
  ): WindowSnapshot | undefined {
    let sensors = this.byRule.get(ruleId);
    if (!sensors) {
      sensors = new Map();
      this.byRule.set(ruleId, sensors);
    }
    let window = sensors.get(sensorId);
    if (!window) {
      window = new SlidingWindow(windowSeconds * 1000);
      sensors.set(sensorId, window);
    }
    return window.add(ts, value, now);
  }

  get(ruleId: string, sensorId: string): SlidingWindow | undefined {
    return this.byRule.get(ruleId)?.get(sensorId);
  }

  /** Atomically installs a rule's windows (built off to the side by warm-up). */
  replaceRule(ruleId: string, sensors: Map<string, SlidingWindow>): void {
    if (sensors.size) this.byRule.set(ruleId, sensors);
    else this.byRule.delete(ruleId);
  }

  dropRule(ruleId: string): void {
    this.byRule.delete(ruleId);
  }

  /** Drops windows that have received nothing for 2x their length (wall clock). */
  sweep(now = Date.now()): number {
    let dropped = 0;
    for (const [ruleId, sensors] of this.byRule) {
      for (const [sensorId, window] of sensors) {
        if (now - window.lastTouched > 2 * window.windowMs) {
          sensors.delete(sensorId);
          dropped++;
        }
      }
      if (!sensors.size) this.byRule.delete(ruleId);
    }
    return dropped;
  }

  get ruleCount(): number {
    return this.byRule.size;
  }
}
