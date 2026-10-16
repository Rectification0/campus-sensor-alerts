# tasks.md — Implementation plan

> Ordered, checkable tasks. **Deps** = tasks that must finish first. **Spec** = requirement IDs from `specs.md`.
> Status: `[ ]` todo · `[~]` in progress · `[x]` done.

---

## Phase 0 — Project setup

- [x] **T0.1 Init git**
  - `git init`, `.gitignore` (node_modules, dist, .env, coverage), initial commit with the planning docs.
- [x] **T0.2 Scaffold project with pnpm**
  - `package.json` (`"type": "module"`, engines node ≥ 22), strict `tsconfig.json`.
  - Dependencies: fastify, @sinclair/typebox, @fastify/type-provider-typebox, pg, undici.
  - Dev dependencies: typescript, tsx, vitest, @types/pg, eslint, typescript-eslint, prettier (+ globals for ESLint). autocannon and pidusage were added at first and later removed (see T7.2).
  - Deps: T0.1
- [x] **T0.3 Scripts**
  - `dev`, `build`, `start`, `db:create`, `db:migrate`, `db:test:reset`, `test`, `lint`, `sim`, `loadtest`.
  - Deps: T0.2
- [x] **T0.4 Config module**
  - `src/config.ts` + `.env.example` (design §4).
  - Deps: T0.2
- [x] **T0.5 Create databases**
  - Create `campus_sensors` and `campus_sensors_test` on the native PostgreSQL 18 service. Needs the `postgres` password.
  - Deps: T0.4

## Phase 1 — Database & app skeleton

- [x] **T1.1 Migration runner**
  - `src/db/migrate.ts`.
  - Deps: T0.5
- [x] **T1.2 `001_init.sql`**
  - readings, rules, alerts, enums, checks, `alerts_one_active` partial unique index (design §5).
  - Deps: T1.1 · Spec: FR-7.3
- [x] **T1.3 `pg` pool**
  - Deps: T0.4
- [x] **T1.4 `buildApp()`**
  - Fastify + TypeBox provider, body limit, pino with request-logging toggle, error handler (specs §8).
  - Deps: T0.2
- [x] **T1.5 `server.ts` bootstrap**
  - Deps: T1.4

## Phase 2 — Rules & engine core

- [x] **T2.1 Rule schemas**
  - Create and patch, with kind ↔ window-field consistency checks.
  - Unit tests.
  - Deps: T1.4 · Spec: FR-4.1, FR-4.2
- [x] **T2.2 Rules repository**
  - Create, get, list, patch (merge + re-validate), set enabled.
  - Deps: T1.2, T2.1
- [x] **T2.3 Rule registry**
  - `Map<type, Rule[]>` of enabled rules; load, upsert, remove.
  - Unit tests.
  - Deps: T2.1 · Spec: FR-4.5
- [x] **T2.4 Operators**
  - gt / gte / lt / lte.
  - Unit tests.
  - Deps: T0.2 · Spec: FR-5
- [x] **T2.5 Window state**
  - Deque, running sum/count, monotonic min/max, eviction, late-reading skip, idle sweep.
  - Unit tests for each aggregation, equal timestamps, boundary eviction and late readings.
  - Deps: T0.2 · Spec: FR-6.1, FR-6.2, FR-6.4
- [x] **T2.6 Evaluator**
  - Sort by ts, THRESHOLD/WINDOW evaluation, coalesce per (rule, sensor) into upsert rows.
  - Unit tests.
  - Deps: T2.3, T2.4, T2.5 · Spec: FR-2.4, FR-5, FR-6, FR-7.2
- [x] **T2.7 Warm-up**
  - Replay readings from the DB into window state without alerts. Used at startup, on WINDOW rule create/edit/enable, and after a failed commit.
  - Deps: T2.5, T1.2 · Spec: FR-6.3
- [x] **T2.8 Rules routes**
  - POST, GET, GET :id, PATCH, enable, disable. Registry update and warm-up happen before responding.
  - Deps: T2.2, T2.3, T2.7 · Spec: FR-4

## Phase 3 — Ingestion with reply-after-commit

- [x] **T3.1 Reading schemas**
  - Reading schema, pre-compiled per-item validator, batch envelope.
  - Deps: T1.4 · Spec: FR-1.2, FR-2.1, FR-2.3
- [x] **T3.2 Ingest buffer with tickets**
  - All-or-nothing push, drain, per-request completion tickets.
  - Unit tests.
  - Deps: T0.2 · Spec: FR-3.3
- [x] **T3.3 Readings + alerts transaction**
  - `unnest` reading insert + sorted alert upsert in one transaction.
  - Deps: T1.2, T1.3 · Spec: FR-1.1, FR-7, NFR-3
- [x] **T3.4 Flusher**
  - Size and interval triggers, in-order evaluation, overlapping commits, ticket resolution on commit, retry of prepared rows within the budget, then reject tickets (503) and warm-up of dirty windows. `flushNow()` hook for tests.
  - Deps: T3.2, T3.3, T2.6, T2.7 · Spec: FR-1.1, FR-3, NFR-3, NFR-4
- [x] **T3.5 Ingest routes**
  - `POST /readings` and `POST /readings/batch`: await the ticket, then 202. Covers partial acceptance and 400/413/503 + Retry-After.
  - Deps: T3.1, T3.4 · Spec: FR-1, FR-2, FR-3.3
- [x] **T3.6 Graceful shutdown**
  - Stop accepting, drain the buffer, await commits, end the pool.
  - Deps: T3.4, T1.5 · Spec: NFR-4
- [x] **T3.7 Startup sequence**
  - migrate check → load registry → warm-up → listen.
  - Deps: T2.8, T3.5

## Phase 4 — Alerts API

- [x] **T4.1 Alert queries**
  - List newest first with limit + cursor; get by id.
  - Deps: T1.2 · Spec: FR-8
- [x] **T4.2 Lifecycle transitions**
  - Conditional UPDATEs, idempotent same-state, 404/409.
  - Deps: T1.2 · Spec: FR-9, NFR-5
- [x] **T4.3 Alerts routes**
  - GET list, GET :id, POST acknowledge, POST resolve.
  - Deps: T4.1, T4.2 · Spec: FR-8, FR-9

## Phase 5 — Integration tests

- [x] **T5.1 Harness**
  - Reset the test DB per suite, `buildApp()` with test config.
  - Deps: T3.7, T4.3
- [x] **T5.2 Ingestion tests**
  - 202 only after rows exist, partial batch, 400/413, 503 when the buffer is full, 503 with zero rows when the DB is unreachable.
  - Deps: T5.1 · Spec: FR-1–FR-3, NFR-3
- [x] **T5.3 Rule tests**
  - CRUD, validation, enable/disable idempotency, changes take effect immediately, edit leaves existing alerts untouched.
  - Deps: T5.1 · Spec: FR-4
- [x] **T5.4 Engine → alert tests**
  - Threshold alert, window alert (incl. history from before rule creation and after a simulated restart), de-dup / `triggerCount`, new alert after resolve, disabled rule doesn't fire, late reading skipped for windows.
  - Deps: T5.1 · Spec: FR-5–FR-7
- [x] **T5.5 Lifecycle tests**
  - OPEN→ACK→RESOLVED, OPEN→RESOLVED, idempotent repeats, 409, 404, pagination.
  - Deps: T5.1 · Spec: FR-8, FR-9

**Phase 5 test map** (run with `pnpm test:int`; needs `TEST_DATABASE_URL`; each test resets the DB):

| File | Covers |
|---|---|
| `test/helpers/{db,app}.ts` | T5.1 harness: DB reset + migrate, `makeApp()` against the test DB |
| `test/integration/ingest.test.ts` | T5.2: 202-after-commit, 400/413, partial batch, 503 on buffer full / DB down / failed commit (+ window rebuild, safe retry), graceful close, duplicates, UTC |
| `test/integration/rules.test.ts` | T5.3: CRUD, validation, 404/400, PATCH semantics, enable/disable idempotency, warm-up, restart reload |
| `test/integration/engine.test.ts` | T5.3/T5.4 end-to-end: edits and enable/disable affect the next reading and leave alerts untouched; window history from before creation and across a restart; eviction; late readings; per-sensor windows |
| `test/integration/alerts.test.ts` | T5.5: list/pagination, get, every lifecycle path, idempotency, 409/404, concurrent transitions |
| `test/integration/migrate.test.ts` | Schema, constraints, one-active-alert index, startup pending-migration check |

## Phase 6 — Simulator

- [x] **T6.1 Patterns**
  - Per-type baselines; normal / spike / drift.
  - Deps: T0.2 · Spec: FR-10.3
- [x] **T6.2 Sender**
  - undici Pool, single/batch modes, rate control, latency histogram.
  - Deps: T6.1 · Spec: FR-10.1, FR-10.2
- [x] **T6.3 CLI**
  - `node:util.parseArgs`, continuous mode, `--burst N` with summary output.
  - Deps: T6.2 · Spec: FR-10
- [x] **T6.4 E2E smoke**
  - Server + seeded rules + `sim --pattern spike` → alerts exist.
  - Done as an automated test (`test/integration/simulator.test.ts`): a real HTTP server on the test DB; rules are created in the test (the T7.1 seed script is still Phase 7).
  - Deps: T6.3, T7.1, T3.7

## Phase 7 — Load test & report

- [x] **T7.1 Rule seed script**
  - ≥ 20 rules, THRESHOLD + WINDOW.
  - Deps: T2.8 · Spec: specs §7
- [x] **T7.2 Harness**
  - LT-A/B/C × 3 runs; latency, completion time, errors/503s, server CPU/event-loop/memory via an in-process probe (`loadtest/probe.mjs`; `pidusage` was dropped because it spawns PowerShell per sample on Windows and distorted results), DB row-count check.
  - Deps: T6.3, T7.1 · Spec: FR-11.1
- [x] **T7.3 Run and tune**
  - Prod build, `REQUEST_LOGGING=false`. Adjust flush and pool knobs (design §8) until FR-3 and NFR-2 pass.
  - Deps: T7.2 · Spec: FR-3, NFR-1, NFR-2
- [x] **T7.4 Write report**
  - `docs/LOAD_TEST_REPORT.md`: machine specs, method, tables, pass/fail, analysis.
  - Deps: T7.3 · Spec: FR-11.2

## Phase 8 — Documentation & submission

- [ ] **T8.1 `docs/ARCHITECTURE.md`**
  - Diagram, data flow, components, trade-offs (design §9), scale-out path, limitations.
  - Deps: T7.4 · Spec: FR-12.2
- [ ] **T8.2 `README.md`**
  - Prerequisites (Node ≥ 22, pnpm, PostgreSQL ≥ 18 — schema uses built-in `uuidv7()`), setup, `.env`, migrate, run, test, simulate, load-test, curl examples.
  - Deps: T6.4 · Spec: FR-12.1
- [ ] **T8.3 Final checks**
  - `pnpm lint && pnpm test && pnpm build`.
  - Fresh-clone walkthrough following the README.
  - Every FR/NFR is covered in the table below.
  - Deps: T8.1, T8.2

---

## Traceability

| Spec | Tasks |
|---|---|
| FR-1 Single ingest | T3.1, T3.3–T3.5, T5.2 |
| FR-2 Batch ingest | T3.1, T3.5, T2.6, T5.2 |
| FR-3 Burst / backpressure | T3.2, T3.4, T3.5, T7.2–T7.4 |
| FR-4 Rule management | T2.1–T2.3, T2.8, T5.3 |
| FR-5 Threshold eval | T2.4, T2.6, T5.4 |
| FR-6 Window eval | T2.5–T2.7, T5.4 |
| FR-7 Alert creation / de-dup | T1.2, T2.6, T3.3, T5.4 |
| FR-8 View alerts | T4.1, T4.3, T5.5 |
| FR-9 Acknowledge / resolve | T4.2, T4.3, T5.5 |
| FR-10 Simulator | T6.1–T6.4 |
| FR-11 Load-test report | T7.1–T7.4 |
| FR-12 Docs | T8.1, T8.2 |
| NFR-1/2 Throughput & latency | T7.3 |
| NFR-3 Durability | T3.3, T3.4, T5.2 |
| NFR-4 Resilience | T3.4, T3.6 |
| NFR-5 Consistency | T1.2, T4.2 |
| NFR-6 UTC time | T3.1, T1.2 |

## Milestones
1. **M1 (Phases 0–2):** schema, rules API, engine unit-tested.
2. **M2 (Phases 3–4):** readings → committed + alerts → lifecycle, end-to-end.
3. **M3 (Phases 5–6):** integration tests green, simulator demo.
4. **M4 (Phase 7):** burst targets met, report written.
5. **M5 (Phase 8):** submission-ready.
