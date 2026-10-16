import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../src/rules/registry.js';
import type { Rule } from '../../src/rules/schemas.js';

function rule(id: string, type = 'temperature', enabled = true): Rule {
  return {
    id,
    kind: 'THRESHOLD',
    type,
    operator: 'gt',
    threshold: 30,
    aggregation: null,
    windowSeconds: null,
    enabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RuleRegistry', () => {
  it('indexes enabled rules by type', () => {
    const reg = new RuleRegistry();
    reg.load([rule('a'), rule('b', 'humidity'), rule('c', 'temperature', false)]);
    expect(reg.forType('temperature').map((r) => r.id)).toEqual(['a']);
    expect(reg.forType('humidity').map((r) => r.id)).toEqual(['b']);
    expect(reg.forType('co2')).toEqual([]);
    expect(reg.size).toBe(2);
  });

  it('upsert replaces, moves between types, and removes disabled rules', () => {
    const reg = new RuleRegistry();
    reg.upsert(rule('a'));
    reg.upsert({ ...rule('a', 'humidity'), threshold: 50 });
    expect(reg.forType('temperature')).toEqual([]);
    expect(reg.forType('humidity')[0]?.threshold).toBe(50);
    reg.upsert(rule('a', 'humidity', false));
    expect(reg.size).toBe(0);
  });

  it('does not mutate arrays already handed out', () => {
    const reg = new RuleRegistry();
    reg.upsert(rule('a'));
    const snapshot = reg.forType('temperature');
    reg.upsert(rule('b'));
    reg.remove('a');
    expect(snapshot.map((r) => r.id)).toEqual(['a']);
    expect(reg.forType('temperature').map((r) => r.id)).toEqual(['b']);
  });
});
