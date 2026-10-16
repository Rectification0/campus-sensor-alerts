import type { Rule } from './schemas.js';

const NONE: readonly Rule[] = Object.freeze([]);

/**
 * In-memory index of enabled rules by metric type (design §7.3).
 * Per-type arrays are replaced, never mutated, so a caller iterating forType()
 * is unaffected by concurrent changes.
 */
export class RuleRegistry {
  private readonly byId = new Map<string, Rule>();
  private readonly byType = new Map<string, readonly Rule[]>();

  load(rules: Iterable<Rule>): void {
    this.byId.clear();
    this.byType.clear();
    for (const rule of rules) this.upsert(rule);
  }

  /** Adds or replaces a rule; a disabled rule is removed. */
  upsert(rule: Rule): void {
    this.remove(rule.id);
    if (!rule.enabled) return;
    this.byId.set(rule.id, rule);
    this.byType.set(rule.type, [...(this.byType.get(rule.type) ?? NONE), rule]);
  }

  remove(id: string): void {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.delete(id);
    const remaining = (this.byType.get(existing.type) ?? NONE).filter((r) => r.id !== id);
    if (remaining.length) this.byType.set(existing.type, remaining);
    else this.byType.delete(existing.type);
  }

  forType(type: string): readonly Rule[] {
    return this.byType.get(type) ?? NONE;
  }

  get(id: string): Rule | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }
}
