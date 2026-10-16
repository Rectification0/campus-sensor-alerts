-- Initial schema (design §5). Requires PostgreSQL 18 for built-in uuidv7().

CREATE TABLE readings (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sensor_id    TEXT             NOT NULL,
  type         TEXT             NOT NULL,
  value        DOUBLE PRECISION NOT NULL,
  recorded_at  TIMESTAMPTZ      NOT NULL,
  received_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);
-- Serves window warm-up: WHERE type = ? AND recorded_at > ? ORDER BY sensor_id, recorded_at
CREATE INDEX readings_type_sensor_time ON readings (type, sensor_id, recorded_at);

CREATE TYPE rule_kind     AS ENUM ('THRESHOLD', 'WINDOW');
CREATE TYPE rule_operator AS ENUM ('gt', 'gte', 'lt', 'lte');
CREATE TYPE rule_agg      AS ENUM ('avg', 'min', 'max');
CREATE TYPE alert_status  AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

CREATE TABLE rules (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  kind           rule_kind        NOT NULL,
  type           TEXT             NOT NULL,
  operator       rule_operator    NOT NULL,
  threshold      DOUBLE PRECISION NOT NULL,
  aggregation    rule_agg,
  window_seconds INTEGER,
  enabled        BOOLEAN          NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
  -- WINDOW rules have both window fields; THRESHOLD rules have neither.
  CONSTRAINT rules_window_fields CHECK (
    (kind = 'WINDOW'    AND aggregation IS NOT NULL AND window_seconds IS NOT NULL) OR
    (kind = 'THRESHOLD' AND aggregation IS NULL     AND window_seconds IS NULL)
  ),
  CONSTRAINT rules_window_range CHECK (window_seconds IS NULL OR window_seconds BETWEEN 10 AND 86400),
  CONSTRAINT rules_threshold_finite CHECK (threshold NOT IN ('NaN', 'Infinity', '-Infinity'))
);

CREATE TABLE alerts (
  id                 UUID PRIMARY KEY DEFAULT uuidv7(),
  rule_id            UUID             NOT NULL REFERENCES rules (id),
  sensor_id          TEXT             NOT NULL,
  type               TEXT             NOT NULL,
  status             alert_status     NOT NULL DEFAULT 'OPEN',
  trigger_value      DOUBLE PRECISION NOT NULL,
  last_value         DOUBLE PRECISION NOT NULL,
  window_start       TIMESTAMPTZ,
  window_end         TIMESTAMPTZ,
  first_triggered_at TIMESTAMPTZ      NOT NULL,
  last_triggered_at  TIMESTAMPTZ      NOT NULL,
  trigger_count      INTEGER          NOT NULL DEFAULT 1 CHECK (trigger_count >= 1),
  acknowledged_at    TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ      NOT NULL DEFAULT now()
);
-- FR-7.3: at most one active (OPEN or ACKNOWLEDGED) alert per (rule, sensor).
CREATE UNIQUE INDEX alerts_one_active ON alerts (rule_id, sensor_id) WHERE status <> 'RESOLVED';
