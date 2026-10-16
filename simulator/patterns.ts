// Value generation for simulated sensors (FR-10.3, design §11).

export type Pattern = 'normal' | 'spike' | 'drift';
export const PATTERNS: readonly Pattern[] = ['normal', 'spike', 'drift'];

export type Random = () => number;

/** Seedable PRNG (mulberry32), so tests and repeated runs can be deterministic. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Baseline {
  base: number;
  spread: number; // normal values stay within base ± spread
  step: number; // max random-walk change per reading
}

export const BASELINES: Readonly<Record<string, Baseline>> = {
  temperature: { base: 22, spread: 3, step: 0.2 }, // °C
  humidity: { base: 45, spread: 10, step: 0.5 }, // %
  co2: { base: 600, spread: 150, step: 10 }, // ppm
};
const DEFAULT_BASELINE: Baseline = { base: 50, spread: 10, step: 1 };

export const SPIKE_PROBABILITY = 0.02;

export function baselineFor(type: string): Baseline {
  return BASELINES[type] ?? DEFAULT_BASELINE;
}

/**
 * One sensor's values for one metric:
 * - normal: random walk kept within base ± spread
 * - spike:  the walk, with a 2% chance of a value 3-4 spreads above base
 *           (e.g. 31-34 °C), which crosses typical THRESHOLD rules
 * - drift:  the walk plus a ramp of one spread per minute, which moves
 *           time-window averages past WINDOW rule thresholds
 */
export class SensorSeries {
  private readonly baseline: Baseline;
  private walk: number;

  constructor(
    type: string,
    private readonly pattern: Pattern,
    private readonly random: Random = Math.random,
  ) {
    this.baseline = baselineFor(type);
    const { base, spread } = this.baseline;
    this.walk = base + (this.random() * 2 - 1) * spread * 0.5;
  }

  next(elapsedSeconds: number): number {
    const { base, spread, step } = this.baseline;
    this.walk += (this.random() * 2 - 1) * step;
    // Reflect at the bounds so values stay within base ± spread.
    if (this.walk > base + spread) this.walk = 2 * (base + spread) - this.walk;
    if (this.walk < base - spread) this.walk = 2 * (base - spread) - this.walk;

    let value = this.walk;
    if (this.pattern === 'spike' && this.random() < SPIKE_PROBABILITY) {
      value = base + spread * (3 + this.random());
    } else if (this.pattern === 'drift') {
      value += (spread / 60) * elapsedSeconds;
    }
    return Math.round(value * 100) / 100;
  }
}

export interface ReadingJson {
  sensorId: string;
  type: string;
  value: number;
  timestamp: string;
}

const BUILDINGS = ['library', 'hostel-a', 'hostel-b', 'lab', 'cafeteria', 'auditorium', 'gym'];

/** Sensor ids like `library-floor-2`; floors increase once every building has one. */
export function sensorId(index: number): string {
  const building = BUILDINGS[index % BUILDINGS.length]!;
  return `${building}-floor-${Math.floor(index / BUILDINGS.length) + 1}`;
}

export interface GeneratorOptions {
  sensors: number;
  types: readonly string[];
  pattern: Pattern;
  random?: Random;
  startedAt?: number; // epoch ms; drift is measured from here
}

/** Cycles round-robin over every (sensor, type) series. */
export class ReadingGenerator {
  private readonly series: { sensorId: string; type: string; values: SensorSeries }[] = [];
  private cursor = 0;
  private readonly startedAt: number;

  constructor({ sensors, types, pattern, random = Math.random, startedAt }: GeneratorOptions) {
    this.startedAt = startedAt ?? Date.now();
    for (let s = 0; s < sensors; s++) {
      for (const type of types) {
        this.series.push({
          sensorId: sensorId(s),
          type,
          values: new SensorSeries(type, pattern, random),
        });
      }
    }
  }

  next(now = Date.now()): ReadingJson {
    const s = this.series[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.series.length;
    return {
      sensorId: s.sensorId,
      type: s.type,
      value: s.values.next((now - this.startedAt) / 1000),
      timestamp: new Date(now).toISOString(),
    };
  }

  take(count: number, now = Date.now()): ReadingJson[] {
    return Array.from({ length: count }, () => this.next(now));
  }

  get seriesCount(): number {
    return this.series.length;
  }
}
