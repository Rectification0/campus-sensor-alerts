import { Type, type Static } from 'typebox';
import type { FieldError } from '../common/errors.js';

export const RuleKind = Type.Union([Type.Literal('THRESHOLD'), Type.Literal('WINDOW')]);
export const Operator = Type.Union([
  Type.Literal('gt'),
  Type.Literal('gte'),
  Type.Literal('lt'),
  Type.Literal('lte'),
]);
export const Aggregation = Type.Union([
  Type.Literal('avg'),
  Type.Literal('min'),
  Type.Literal('max'),
]);

export type RuleKind = Static<typeof RuleKind>;
export type Operator = Static<typeof Operator>;
export type Aggregation = Static<typeof Aggregation>;

const MetricType = Type.String({ minLength: 1, maxLength: 32 });
const WindowSeconds = Type.Integer({ minimum: 10, maximum: 86_400 });

// Field-level validation is done by Fastify/Ajv; kind <-> window-field consistency by ruleShapeErrors().
export const CreateRuleBody = Type.Object(
  {
    kind: RuleKind,
    type: MetricType,
    operator: Operator,
    threshold: Type.Number(),
    aggregation: Type.Optional(Aggregation),
    windowSeconds: Type.Optional(WindowSeconds),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type CreateRuleBody = Static<typeof CreateRuleBody>;

// `null` clears a window field, e.g. when switching a WINDOW rule to THRESHOLD.
export const PatchRuleBody = Type.Object(
  {
    kind: Type.Optional(RuleKind),
    type: Type.Optional(MetricType),
    operator: Type.Optional(Operator),
    threshold: Type.Optional(Type.Number()),
    aggregation: Type.Optional(Type.Union([Aggregation, Type.Null()])),
    windowSeconds: Type.Optional(Type.Union([WindowSeconds, Type.Null()])),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type PatchRuleBody = Static<typeof PatchRuleBody>;

export const RuleIdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
export type RuleIdParams = Static<typeof RuleIdParams>;

/** The editable definition of a rule. */
export interface RuleDefinition {
  kind: RuleKind;
  type: string;
  operator: Operator;
  threshold: number;
  aggregation: Aggregation | null;
  windowSeconds: number | null;
}

export interface Rule extends RuleDefinition {
  id: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** WINDOW rules need both window fields; THRESHOLD rules must have neither (FR-4.1). */
export function ruleShapeErrors(def: RuleDefinition): FieldError[] {
  const errors: FieldError[] = [];
  if (def.kind === 'WINDOW') {
    if (def.aggregation == null) {
      errors.push({ path: '/aggregation', message: 'is required for WINDOW rules' });
    }
    if (def.windowSeconds == null) {
      errors.push({ path: '/windowSeconds', message: 'is required for WINDOW rules' });
    }
  } else {
    if (def.aggregation != null) {
      errors.push({ path: '/aggregation', message: 'is not allowed for THRESHOLD rules' });
    }
    if (def.windowSeconds != null) {
      errors.push({ path: '/windowSeconds', message: 'is not allowed for THRESHOLD rules' });
    }
  }
  return errors;
}

export function definitionFromCreate(body: CreateRuleBody): RuleDefinition {
  return {
    kind: body.kind,
    type: body.type,
    operator: body.operator,
    threshold: body.threshold,
    aggregation: body.aggregation ?? null,
    windowSeconds: body.windowSeconds ?? null,
  };
}

/**
 * Merges a PATCH body onto the current definition. Switching to THRESHOLD clears window
 * fields the patch does not mention, so `{ "kind": "THRESHOLD" }` alone is a valid edit.
 */
export function applyRulePatch(current: RuleDefinition, patch: PatchRuleBody): RuleDefinition {
  const next: RuleDefinition = {
    kind: patch.kind ?? current.kind,
    type: patch.type ?? current.type,
    operator: patch.operator ?? current.operator,
    threshold: patch.threshold ?? current.threshold,
    aggregation: patch.aggregation !== undefined ? patch.aggregation : current.aggregation,
    windowSeconds: patch.windowSeconds !== undefined ? patch.windowSeconds : current.windowSeconds,
  };
  if (patch.kind === 'THRESHOLD') {
    if (patch.aggregation === undefined) next.aggregation = null;
    if (patch.windowSeconds === undefined) next.windowSeconds = null;
  }
  return next;
}
