import type pg from 'pg';
import { listRules } from '../rules/repository.js';
import { RuleRegistry } from '../rules/registry.js';
import type { Rule } from '../rules/schemas.js';
import { evaluate, type EvaluationResult, type Reading } from './evaluator.js';
import { buildWindows } from './warmup.js';
import { WindowStore } from './window.js';

/** Owns the in-memory rule registry and window state for this process. */
export class RuleEngine {
  readonly registry = new RuleRegistry();
  readonly windows = new WindowStore();

  constructor(private readonly db: pg.Pool) {}

  /** Startup: load enabled rules and warm up all WINDOW rules from stored readings. */
  async loadAll(): Promise<void> {
    const rules = await listRules(this.db, { enabledOnly: true });
    const built = await buildWindows(this.db, rules);
    for (const [ruleId, sensors] of built) this.windows.replaceRule(ruleId, sensors);
    this.registry.load(rules);
  }

  /**
   * Makes a just-committed rule change effective (FR-4.5). WINDOW state is rebuilt off to
   * the side, then installed together with the registry entry in one synchronous step.
   * Readings evaluated between the history query and that step are not in the rebuilt
   * window; this gap is bounded by one query's duration.
   */
  async applyRule(rule: Rule): Promise<void> {
    if (!rule.enabled) {
      this.registry.remove(rule.id);
      this.windows.dropRule(rule.id);
      return;
    }
    if (rule.kind === 'WINDOW') {
      const built = await buildWindows(this.db, [rule]);
      this.windows.replaceRule(rule.id, built.get(rule.id)!);
    } else {
      this.windows.dropRule(rule.id);
    }
    this.registry.upsert(rule);
  }

  evaluate(readings: readonly Reading[], now = Date.now()): EvaluationResult {
    return evaluate(readings, this.registry, this.windows, now);
  }
}
