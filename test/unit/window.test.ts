import { describe, expect, it } from 'vitest';
import { SlidingWindow, WindowStore } from '../../src/engine/window.js';

const S = 1000;

describe('SlidingWindow', () => {
  it('computes avg, min and max over the window', () => {
    const w = new SlidingWindow(600 * S);
    w.add(0, 20);
    w.add(60 * S, 30);
    const snap = w.add(120 * S, 25)!;
    expect(snap).toMatchObject({ count: 3, avg: 25, min: 20, max: 30 });
    expect(snap.windowStart).toBe(0);
    expect(snap.windowEnd).toBe(120 * S);
  });

  it('window is (t - length, t]: a sample exactly one length old is evicted', () => {
    const w = new SlidingWindow(10 * S);
    w.add(0, 100);
    const snap = w.add(10 * S, 1)!;
    expect(snap).toMatchObject({ count: 1, avg: 1, min: 1, max: 1, windowStart: 10 * S });
    expect(w.add(19_999, 3)).toMatchObject({ count: 2, avg: 2 });
  });

  it('updates min and max as extremes are evicted', () => {
    const w = new SlidingWindow(10 * S);
    w.add(0, 5);
    w.add(2 * S, 50);
    w.add(4 * S, 10);
    expect(w.add(6 * S, 20)).toMatchObject({ min: 5, max: 50 });
    expect(w.add(11 * S, 15)).toMatchObject({ min: 10, max: 50 }); // 5 evicted
    expect(w.add(13 * S, 12)).toMatchObject({ min: 10, max: 20 }); // 50 evicted
  });

  it('accepts equal timestamps', () => {
    const w = new SlidingWindow(10 * S);
    w.add(5 * S, 1);
    expect(w.add(5 * S, 3)).toMatchObject({ count: 2, avg: 2 });
  });

  it('ignores late readings (FR-6.4)', () => {
    const w = new SlidingWindow(10 * S);
    w.add(5 * S, 1);
    expect(w.add(4 * S, 100)).toBeUndefined();
    expect(w.add(6 * S, 3)).toMatchObject({ count: 2, avg: 2, max: 3 });
  });

  it('stays exact over many evictions', () => {
    const w = new SlidingWindow(100);
    let snap;
    for (let t = 0; t < 250_000; t++) snap = w.add(t, (t % 7) + 0.1);
    // Last 100 samples: t = 249_900..249_999
    let expected = 0;
    for (let t = 249_900; t < 250_000; t++) expected += (t % 7) + 0.1;
    expect(snap!.count).toBe(100);
    expect(snap!.avg).toBeCloseTo(expected / 100, 9);
  });
});

describe('WindowStore', () => {
  it('keeps separate windows per rule and sensor', () => {
    const store = new WindowStore();
    store.add('r1', 60, 's1', 0, 10);
    store.add('r1', 60, 's2', 0, 20);
    expect(store.add('r1', 60, 's1', S, 30)).toMatchObject({ avg: 20 });
    expect(store.add('r2', 60, 's1', S, 99)).toMatchObject({ count: 1 });
  });

  it('sweeps windows idle for twice their length', () => {
    const store = new WindowStore();
    store.add('r1', 10, 's1', 0, 1, 0);
    store.add('r1', 10, 's2', 0, 1, 15 * S);
    expect(store.sweep(21 * S)).toBe(1);
    expect(store.get('r1', 's1')).toBeUndefined();
    expect(store.get('r1', 's2')).toBeDefined();
    expect(store.sweep(100 * S)).toBe(1);
    expect(store.ruleCount).toBe(0);
  });
});
