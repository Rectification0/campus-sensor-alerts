# specs.md — Campus Sensor Monitoring & Alerts (GDG Backend Task 1)

> Source: `GDG_Backend_Task_1_Campus_Sensor_Functionality.pdf`.
> This file defines **what** the system must do. `design.md` covers **how**; `tasks.md` covers **in what order**.
> **Scope rule:** every requirement below traces to a line of the PDF (see the "PDF" column in §5). Anything the PDF does not list is excluded.

---

## 1. Purpose (PDF §1)

A backend service that:
- ingests campus sensor readings,
- evaluates organizer-defined alert rules, and
- lets organizers manage the alerts that are generated.

## 2. Scope

### In scope (PDF §2, §4, §5)

| # | Item | PDF reference |
|---|---|---|
| 1 | Accept individual sensor readings and batches of readings | §2, §4 |
| 2 | Handle bursts of 10,000 readings in one second | §2, §4 |
| 3 | Create, edit, enable and disable alert rules | §2, §4 |
| 4 | Single-reading rules (e.g. temperature exceeding a threshold) | §2 |
| 5 | Time-window rules (e.g. average temperature over ten minutes exceeding a threshold) | §2 |
| 6 | Create an alert when a reading or time window satisfies a rule | §2, §4 |
| 7 | View, acknowledge and resolve alerts | §2, §4 |
| 8 | Sensor simulator for testing | §2, §5 |
| 9 | Source code + install/run instructions | §5 |
| 10 | Load-test report for the 10k/1s burst | §5 |
| 11 | Architecture and throughput/reliability trade-off explanation | §5 |

### Explicitly excluded (PDF §6, plus anything not listed)

- Frontend or dashboard, authentication, organizer identity or audit fields.
- Notifications, health/readiness/stats endpoints, API docs UI, and endpoints to query raw readings.
- Rule names, descriptions, severities, sensor scoping, rule deletion, and alert/rule filtering.
- Docker packaging and coverage targets.

## 3. Glossary

| Term | Meaning |
|---|---|
| Reading | One measurement: `sensorId`, `type`, `value`, `timestamp` (PDF §3). |
| Rule | An organizer-defined condition. Its kind is `THRESHOLD` (single reading) or `WINDOW` (time-window aggregate). A rule watches one metric `type` and is evaluated separately for every sensor reporting that type. |
| Alert | A record created when a rule is satisfied for a sensor. |
| Active alert | An alert with status `OPEN` or `ACKNOWLEDGED`. |

## 4. Core data

### 4.1 Reading (PDF §3)

| Field | Type | Validation |
|---|---|---|
| `sensorId` | string | Required, 1–64 chars (e.g. `library-floor-2`). |
| `type` | string | Required, 1–32 chars (e.g. `temperature`). |
| `value` | number | Required, finite. |
| `timestamp` | string | Required, ISO-8601 date-time with timezone (e.g. `2026-10-12T10:30:00Z`). Stored as UTC. |

Unknown extra fields are rejected.

### 4.2 Rule

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Server-generated. |
| `kind` | enum | `THRESHOLD` \| `WINDOW`. |
| `type` | string | Metric this rule watches (e.g. `temperature`). |
| `operator` | enum | `gt` \| `gte` \| `lt` \| `lte`. These are the comparison forms of "exceeding / below a threshold". |
| `threshold` | number | Required, finite. |
| `aggregation` | enum | WINDOW only: `avg` \| `min` \| `max`. |
| `windowSeconds` | int | WINDOW only, 10–86,400 (the PDF example is 600 s = ten minutes). |
| `enabled` | bool | Default `true`. |
| `createdAt`, `updatedAt` | timestamp | Server-managed. |

The PDF's examples are introduced with "such as", so the comparison operators and aggregations are kept general. `avg` is the PDF's own example; `min` and `max` are the other basic window aggregates.

### 4.3 Alert

| Field | Type | Meaning |
|---|---|---|
| `id` | uuid | Server-generated. |
| `ruleId` | uuid | Rule that fired. |
| `sensorId`, `type` | string | Sensor and metric that triggered the alert. |
| `status` | enum | `OPEN` \| `ACKNOWLEDGED` \| `RESOLVED`. |
| `triggerValue` | number | Reading value (THRESHOLD) or aggregate (WINDOW) at the first trigger. |
| `lastValue` | number | Value or aggregate at the most recent trigger. |
| `windowStart`, `windowEnd` | timestamp? | WINDOW only: bounds of the first triggering window. |
| `firstTriggeredAt`, `lastTriggeredAt` | timestamp | Reading timestamps of the first and latest trigger. |
| `triggerCount` | int | How many times the rule was satisfied while this alert was active. |
| `acknowledgedAt`, `resolvedAt` | timestamp? | When the lifecycle actions happened. |
| `createdAt`, `updatedAt` | timestamp | Server-managed. |

---

## 5. Functional requirements

Acceptance criteria use EARS style ("WHEN … THE SYSTEM SHALL …").

| ID | PDF |
|---|---|
| FR-1 Single ingestion | §2 "individual readings", §4 |
| FR-2 Batch ingestion | §2 "batches", §4 |
| FR-3 Burst | §2 "10,000 readings in one second", §4 |
| FR-4 Rule management | §2 "create, edit, enable, disable", §4 |
| FR-5 Threshold rules | §2 "single reading" |
| FR-6 Window rules | §2 "time-window rules", §4 "time-window aggregate" |
| FR-7 Alert creation | §2 "create an alert whenever…", §4 |
| FR-8 View alerts | §2, §4 "view" |
| FR-9 Acknowledge / resolve | §2, §4 "acknowledge … resolve" |
| FR-10 Simulator | §2, §5 |
| FR-11 Load-test report | §5 |
| FR-12 Docs | §5 |

### FR-1 Single reading ingestion
- **FR-1.1** WHEN a client sends `POST /api/v1/readings` with a valid reading, THE SYSTEM SHALL persist it, evaluate it against all enabled rules for its `type`, and only then respond `202` with `{ "accepted": 1 }`. A `202` therefore means the reading **and any resulting alert change** are committed.
- **FR-1.2** WHEN the reading fails validation (§4.1), THE SYSTEM SHALL respond `400` with field errors and store nothing.

### FR-2 Batch ingestion
- **FR-2.1** WHEN a client sends `POST /api/v1/readings/batch` with a JSON array of 1–1000 readings, THE SYSTEM SHALL validate each item independently.
- **FR-2.2** Valid items SHALL be committed and evaluated as in FR-1.1, even if other items are invalid. Response: `202` with `{ "accepted": n, "rejected": [{ "index": i, "errors": [...] }] }`.
- **FR-2.3** IF every item is invalid → `400` (same body shape). IF the array is empty or has more than 1000 items → `400`. IF the body exceeds 1 MB → `413`.
- **FR-2.4** Readings are evaluated in timestamp order within a batch.

### FR-3 Burst handling (10,000 readings / second)
- **FR-3.1** THE SYSTEM SHALL accept a burst of 10,000 readings delivered within one second, in each load-test shape of §7, with **0 failed requests** on the reference machine.
- **FR-3.2** Because of FR-1.1, every `202` in the burst implies the reading is already committed. The final response of the burst SHALL arrive within **3 s** of the burst starting.
- **FR-3.3** IF the service cannot take more readings (internal buffer full), or cannot commit them (database unavailable after retries), THE SYSTEM SHALL respond `503` with `Retry-After`. **A `503` guarantees nothing was committed**, so the client can safely retry.
- **FR-3.4** Duplicate readings (same sensorId, type, timestamp) are stored as sent and not de-duplicated.

### FR-4 Rule management
- **FR-4.1** `POST /api/v1/rules` SHALL create a rule (`201`). Invalid bodies get `400`. This includes a WINDOW rule missing `aggregation`/`windowSeconds`, and a THRESHOLD rule that has them.
- **FR-4.2** `PATCH /api/v1/rules/:id` SHALL edit `type`, `operator`, `threshold`, `aggregation` and `windowSeconds` (and `kind`, with the same consistency checks). Unknown id → `404`.
- **FR-4.3** `POST /api/v1/rules/:id/enable` and `POST /api/v1/rules/:id/disable` SHALL set `enabled`. Both are idempotent and return the rule.
- **FR-4.4** `GET /api/v1/rules` and `GET /api/v1/rules/:id` SHALL return rules. *Supporting read: organizers need rule ids and current values in order to edit, enable and disable.*
- **FR-4.5** A rule change SHALL apply to every reading committed after the API call returns.
- **FR-4.6** Editing or disabling a rule SHALL NOT modify alerts it already created.

### FR-5 Single-reading (THRESHOLD) evaluation
- **FR-5.1** For each committed reading and each enabled THRESHOLD rule with the same `type`, THE SYSTEM SHALL evaluate `value <operator> threshold`. If true, it SHALL raise an alert per FR-7.
  Example: rule `temperature gt 30`, reading `34.5` → alert.

### FR-6 Time-window (WINDOW) evaluation
- **FR-6.1** Windows are **sliding** and use **event time**. For a reading of sensor *s* at timestamp *t*, the window is `(t − windowSeconds, t]` over sensor *s*'s readings of the rule's `type`.
- **FR-6.2** THE SYSTEM SHALL compute `aggregation` over that window and evaluate `aggregate <operator> threshold`. If true, it SHALL raise an alert per FR-7.
  Example: rule `temperature avg 600 s gt 28`. Readings averaging 28.4 over the last ten minutes → alert.
- **FR-6.3** Windows SHALL include readings stored before the rule was created or enabled, and before a service restart. Window history comes from the database, not only from memory.
- **FR-6.4** A reading older than the newest reading already seen for that (rule, sensor) is **late**. It is stored and evaluated by THRESHOLD rules but does not enter window state.

### FR-7 Alert creation
- **FR-7.1** WHEN a rule is satisfied for a sensor and no active alert exists for that (rule, sensor), THE SYSTEM SHALL create an alert with status `OPEN`.
- **FR-7.2** WHEN a rule is satisfied and an active alert already exists for that (rule, sensor), THE SYSTEM SHALL record the trigger on that alert: `triggerCount += 1`, plus updated `lastValue` and `lastTriggeredAt`. It SHALL NOT create a duplicate alert.
  *Interpretation of "create an alert whenever…": every satisfying reading or window is recorded, but repeats of an unresolved condition are counted rather than flooding organizers (a 10k burst could otherwise create thousands of alerts).*
- **FR-7.3** At most one active alert per (rule, sensor). This is enforced by the database.
- **FR-7.4** Once an alert is RESOLVED, the next satisfying reading or window creates a new alert.

### FR-8 View alerts
- **FR-8.1** `GET /api/v1/alerts` SHALL list alerts newest first. Pagination: `limit` (default 50, max 200) and `cursor`. The response carries `nextCursor`.
- **FR-8.2** `GET /api/v1/alerts/:id` SHALL return one alert or `404`.

### FR-9 Acknowledge and resolve
- **FR-9.1** `POST /api/v1/alerts/:id/acknowledge`: `OPEN → ACKNOWLEDGED`, sets `acknowledgedAt`.
- **FR-9.2** `POST /api/v1/alerts/:id/resolve`: `OPEN | ACKNOWLEDGED → RESOLVED`, sets `resolvedAt`.
- **FR-9.3** Repeating a transition already applied (acknowledge an ACKNOWLEDGED alert, resolve a RESOLVED alert) → `200`, alert unchanged.
- **FR-9.4** Acknowledging a RESOLVED alert → `409`. `RESOLVED` is terminal. Unknown id → `404`.

### FR-10 Sensor simulator
- **FR-10.1** A CLI (`pnpm sim`) SHALL generate readings and send them to the service.
- **FR-10.2** Options: `--url`, `--sensors <n>`, `--types <list>`, `--rate <readings/s>`, `--duration <s>`, `--mode single|batch`, `--batch-size <n>`, `--pattern normal|spike|drift`.
- **FR-10.3** Patterns (so that both rule kinds can be exercised):
  - `normal`: realistic random walk.
  - `spike`: occasional threshold-crossing values (THRESHOLD rules).
  - `drift`: slow rise (WINDOW rules).
- **FR-10.4** `--burst <count>` SHALL send exactly *count* readings within ~1 s and print sent/accepted/rejected/errors and latency percentiles.

### FR-11 Load-test report
- **FR-11.1** `pnpm loadtest` SHALL run the §7 scenarios and record:
  - latency p50/p95/p99/max,
  - total burst completion time,
  - error and `503` counts,
  - a DB row-count check (rows added = readings accepted),
  - CPU and memory.
- **FR-11.2** Results go into `docs/LOAD_TEST_REPORT.md`, with machine specs and analysis.

### FR-12 Documentation
- **FR-12.1** `README.md`: prerequisites, install, DB setup, run, test, simulator and load-test commands, and curl examples.
- **FR-12.2** `docs/ARCHITECTURE.md`: components, data flow, and throughput and reliability trade-offs.

---

## 6. Non-functional requirements

| ID | Requirement | PDF |
|---|---|---|
| NFR-1 Throughput | Meet FR-3 with one Node.js process on the reference machine. | §2, §4 |
| NFR-2 Latency | During the burst: batch requests p99 < 1 s; single-reading requests p99 < 2 s. | §5 (report performance) |
| NFR-3 Durability | A `202` is sent only after the PostgreSQL transaction containing the reading (and its alert changes) commits. Accepted readings survive a process crash or power loss. | §5 (reliability trade-offs) |
| NFR-4 Resilience | Failed commits retry with exponential backoff for up to ~5 s. After that, the affected requests get `503` (FR-3.3). Graceful shutdown finishes in-flight commits before exit. | §5 (reliability) |
| NFR-5 Consistency | Alert lifecycle transitions are atomic, and FR-7.3 is DB-enforced. | §4 |
| NFR-6 Time | All timestamps are stored and returned in UTC ISO-8601. | §3 |

## 7. Load-test scenarios ("10,000 readings in one second")

| ID | Shape |
|---|---|
| LT-A | 10 batch requests × 1000 readings, fired concurrently within 1 s |
| LT-B | 100 batch requests × 100 readings within 1 s |
| LT-C | 10,000 single-reading requests within 1 s |

Each scenario uses 200 sensors × 3 types and ≥ 20 enabled rules (THRESHOLD and WINDOW), so rule evaluation is included in the measured cost. There are 3 runs per scenario; the report gives the median and the worst run.

**Pass:** FR-3.1 and FR-3.2 hold for every scenario, and the DB row count matches the accepted count exactly.

## 8. Error format

Fastify's standard error shape, plus per-field errors on validation failures:
```json
{ "statusCode": 400, "error": "Bad Request", "message": "...", "errors": [{ "path": "/value", "message": "must be number" }] }
```

## 9. Assumptions

1. A single service instance is sufficient for the brief.
2. Sensors are trusted. Any `sensorId` is accepted without registration (the PDF lists no sensor management).
3. Raw readings are kept indefinitely (the PDF lists no retention).
