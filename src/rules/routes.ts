import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { badRequest, notFound } from '../common/errors.js';
import type { RuleEngine } from '../engine/engine.js';
import { createRule, getRule, listRules, patchRule, setRuleEnabled } from './repository.js';
import {
  CreateRuleBody,
  definitionFromCreate,
  PatchRuleBody,
  RuleIdParams,
  ruleShapeErrors,
} from './schemas.js';

export interface RulesRoutesOptions {
  pool: pg.Pool;
  engine: RuleEngine;
}

// Every mutation commits to PostgreSQL, then updates the engine before responding (FR-4.5).
export const rulesRoutes: FastifyPluginAsyncTypebox<RulesRoutesOptions> = async (
  app,
  { pool, engine },
) => {
  app.post('/rules', { schema: { body: CreateRuleBody } }, async (req, reply) => {
    const def = definitionFromCreate(req.body);
    const errors = ruleShapeErrors(def);
    if (errors.length) throw badRequest(errors);
    const rule = await createRule(pool, def, req.body.enabled ?? true);
    await engine.applyRule(rule);
    return reply.status(201).send(rule);
  });

  app.get('/rules', async () => ({ items: await listRules(pool) }));

  app.get('/rules/:id', { schema: { params: RuleIdParams } }, async (req) => {
    const rule = await getRule(pool, req.params.id);
    if (!rule) throw notFound('Rule');
    return rule;
  });

  app.patch(
    '/rules/:id',
    { schema: { params: RuleIdParams, body: PatchRuleBody } },
    async (req) => {
      const rule = await patchRule(pool, req.params.id, req.body);
      await engine.applyRule(rule);
      return rule;
    },
  );

  for (const [action, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    app.post(`/rules/:id/${action}`, { schema: { params: RuleIdParams } }, async (req) => {
      const rule = await setRuleEnabled(pool, req.params.id, enabled);
      await engine.applyRule(rule);
      return rule;
    });
  }
};
