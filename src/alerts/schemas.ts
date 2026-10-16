import { Type, type Static } from 'typebox';

export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface Alert {
  id: string;
  ruleId: string;
  sensorId: string;
  type: string;
  status: AlertStatus;
  triggerValue: number;
  lastValue: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  firstTriggeredAt: Date;
  lastTriggeredAt: Date;
  triggerCount: number;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const AlertIdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
export type AlertIdParams = Static<typeof AlertIdParams>;

// FR-8.1: cursor pagination only; the PDF lists no alert filters.
export const ListAlertsQuery = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    cursor: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { additionalProperties: false },
);
export type ListAlertsQuery = Static<typeof ListAlertsQuery>;
