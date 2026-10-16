import type pg from 'pg';
import { badRequest, notFound } from '../common/errors.js';
import {
  applyRulePatch,
  ruleShapeErrors,
  type PatchRuleBody,
  type Rule,
  type RuleDefinition,
} from './schemas.js';

interface RuleRow {
  id: string;
  kind: Rule['kind'];
  type: string;
  operator: Rule['operator'];
  threshold: number;
  aggregation: Rule['aggregation'];
  window_seconds: number | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    kind: row.kind,
    type: row.type,
    operator: row.operator,
    threshold: row.threshold,
    aggregation: row.aggregation,
    windowSeconds: row.window_seconds,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createRule(db: pg.Pool, def: RuleDefinition, enabled = true): Promise<Rule> {
  const { rows } = await db.query<RuleRow>(
    `INSERT INTO rules (kind, type, operator, threshold, aggregation, window_seconds, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [def.kind, def.type, def.operator, def.threshold, def.aggregation, def.windowSeconds, enabled],
  );
  return toRule(rows[0]!);
}

export async function getRule(db: pg.Pool, id: string): Promise<Rule | undefined> {
  const { rows } = await db.query<RuleRow>('SELECT * FROM rules WHERE id = $1', [id]);
  return rows[0] && toRule(rows[0]);
}

export async function listRules(
  db: pg.Pool,
  opts: { enabledOnly?: boolean } = {},
): Promise<Rule[]> {
  const { rows } = await db.query<RuleRow>(
    `SELECT * FROM rules ${opts.enabledOnly ? 'WHERE enabled' : ''} ORDER BY id`,
  );
  return rows.map(toRule);
}

/** Applies a PATCH under a row lock so concurrent edits cannot interleave (FR-4.2). */
export async function patchRule(db: pg.Pool, id: string, patch: PatchRuleBody): Promise<Rule> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<RuleRow>('SELECT * FROM rules WHERE id = $1 FOR UPDATE', [
      id,
    ]);
    if (!rows[0]) throw notFound('Rule');
    const next = applyRulePatch(toRule(rows[0]), patch);
    const errors = ruleShapeErrors(next);
    if (errors.length) throw badRequest(errors);
    const updated = await client.query<RuleRow>(
      `UPDATE rules
       SET kind = $2, type = $3, operator = $4, threshold = $5, aggregation = $6,
           window_seconds = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        id,
        next.kind,
        next.type,
        next.operator,
        next.threshold,
        next.aggregation,
        next.windowSeconds,
      ],
    );
    await client.query('COMMIT');
    return toRule(updated.rows[0]!);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Idempotent: `updated_at` only moves when `enabled` actually changes (FR-4.3). */
export async function setRuleEnabled(db: pg.Pool, id: string, enabled: boolean): Promise<Rule> {
  const { rows } = await db.query<RuleRow>(
    `UPDATE rules
     SET enabled = $2, updated_at = CASE WHEN enabled = $2 THEN updated_at ELSE now() END
     WHERE id = $1 RETURNING *`,
    [id, enabled],
  );
  if (!rows[0]) throw notFound('Rule');
  return toRule(rows[0]);
}
