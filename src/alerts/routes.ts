import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { notFound } from '../common/errors.js';
import { getAlert, listAlerts, transitionAlert } from './repository.js';
import { AlertIdParams, ListAlertsQuery } from './schemas.js';

export interface AlertsRoutesOptions {
  pool: pg.Pool;
}

export const alertsRoutes: FastifyPluginAsyncTypebox<AlertsRoutesOptions> = async (
  app,
  { pool },
) => {
  app.get('/alerts', { schema: { querystring: ListAlertsQuery } }, async (req) =>
    listAlerts(pool, { limit: req.query.limit ?? 50, cursor: req.query.cursor }),
  );

  app.get('/alerts/:id', { schema: { params: AlertIdParams } }, async (req) => {
    const alert = await getAlert(pool, req.params.id);
    if (!alert) throw notFound('Alert');
    return alert;
  });

  for (const action of ['acknowledge', 'resolve'] as const) {
    app.post(`/alerts/:id/${action}`, { schema: { params: AlertIdParams } }, async (req) =>
      transitionAlert(pool, req.params.id, action),
    );
  }
};
