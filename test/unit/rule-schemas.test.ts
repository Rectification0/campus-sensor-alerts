import { describe, expect, it } from 'vitest';
import { applyRulePatch, ruleShapeErrors, type RuleDefinition } from '../../src/rules/schemas.js';

const threshold: RuleDefinition = {
  kind: 'THRESHOLD',
  type: 'temperature',
  operator: 'gt',
  threshold: 30,
  aggregation: null,
  windowSeconds: null,
};
const windowRule: RuleDefinition = {
  ...threshold,
  kind: 'WINDOW',
  aggregation: 'avg',
  windowSeconds: 600,
};

describe('ruleShapeErrors', () => {
  it('accepts consistent rules', () => {
    expect(ruleShapeErrors(threshold)).toEqual([]);
    expect(ruleShapeErrors(windowRule)).toEqual([]);
  });

  it('requires window fields on WINDOW rules', () => {
    const errors = ruleShapeErrors({ ...windowRule, aggregation: null, windowSeconds: null });
    expect(errors.map((e) => e.path)).toEqual(['/aggregation', '/windowSeconds']);
  });

  it('rejects window fields on THRESHOLD rules', () => {
    const errors = ruleShapeErrors({ ...threshold, aggregation: 'max' });
    expect(errors).toEqual([
      { path: '/aggregation', message: 'is not allowed for THRESHOLD rules' },
    ]);
  });
});

describe('applyRulePatch', () => {
  it('changes only the provided fields', () => {
    expect(applyRulePatch(windowRule, { threshold: 25 })).toEqual({ ...windowRule, threshold: 25 });
  });

  it('clears window fields when switching to THRESHOLD', () => {
    expect(applyRulePatch(windowRule, { kind: 'THRESHOLD' })).toEqual(threshold);
  });

  it('keeps explicitly provided window fields so validation can reject them', () => {
    const next = applyRulePatch(windowRule, { kind: 'THRESHOLD', aggregation: 'avg' });
    expect(ruleShapeErrors(next)).toHaveLength(1);
  });

  it('switching to WINDOW needs the window fields', () => {
    expect(ruleShapeErrors(applyRulePatch(threshold, { kind: 'WINDOW' }))).toHaveLength(2);
    const next = applyRulePatch(threshold, {
      kind: 'WINDOW',
      aggregation: 'min',
      windowSeconds: 60,
    });
    expect(ruleShapeErrors(next)).toEqual([]);
  });
});
