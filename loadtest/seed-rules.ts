// T7.1: the rule set used by the load test (specs §7 requires >= 20 enabled rules,
// THRESHOLD and WINDOW). Per metric type: 3 THRESHOLD + 5 WINDOW rules = 24 rules.
// Some thresholds sit inside the simulator's normal range on purpose, so alert
// upserts are part of the measured cost, not just rule evaluation.
//
//   pnpm loadtest:seed [--url http://127.0.0.1:3000]

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BASELINES } from '../simulator/patterns.js';

type RuleBody = Record<string, string | number>;

export function loadTestRules(): RuleBody[] {
  const rules: RuleBody[] = [];
  for (const [type, { base, spread }] of Object.entries(BASELINES)) {
    const t = { type, kind: 'THRESHOLD' };
    rules.push(
      { ...t, operator: 'gt', threshold: base + spread * 0.5 }, // fires on normal data
      { ...t, operator: 'gte', threshold: base + spread * 3 }, // fires on spikes only
      { ...t, operator: 'lt', threshold: base - spread * 2 }, // never fires on normal data
    );
    const w = { type, kind: 'WINDOW' };
    rules.push(
      { ...w, aggregation: 'avg', windowSeconds: 60, operator: 'gt', threshold: base }, // fires
      { ...w, aggregation: 'avg', windowSeconds: 600, operator: 'gt', threshold: base + spread },
      {
        ...w,
        aggregation: 'max',
        windowSeconds: 300,
        operator: 'gte',
        threshold: base + spread * 0.9,
      },
      {
        ...w,
        aggregation: 'min',
        windowSeconds: 300,
        operator: 'lt',
        threshold: base - spread * 2,
      },
      { ...w, aggregation: 'avg', windowSeconds: 600, operator: 'lt', threshold: base - spread },
    );
  }
  return rules;
}

export async function seedRules(baseUrl: string): Promise<number> {
  const rules = loadTestRules();
  for (const rule of rules) {
    const res = await fetch(new URL('/api/v1/rules', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rule),
    });
    if (res.status !== 201) {
      throw new Error(`Creating rule failed: ${res.status} ${await res.text()}`);
    }
  }
  return rules.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { url: { type: 'string', default: 'http://127.0.0.1:3000' } },
  });
  const n = await seedRules(values.url);
  console.log(`Created ${n} rules at ${values.url}`);
}
