# Porting Plan: Health Data Hub to MQTT

This document is the living engineering plan for porting the reference Health Data Hub implementation to a Node.js + TypeScript MQTT-first server.

Use this file for planning, technical discussion, implementation sequencing, open decisions, and compatibility tracking. User-facing documentation belongs in `README.md`. Agent and maintainer working rules belong in `AGENTS.md`.

## 1) Non-Negotiable Project Rules

- `reference-implementation/` is read-only reference material. Do not edit, format, rename, move, or delete anything inside it.
- All commits, documentation, code comments, review comments, and user-facing repository text must be written in English.
- Use current Node.js, current maintained frameworks, and established best practices at implementation time.
- Self-hosting must be first-class through `Dockerfile` and `docker-compose.yml`.
- Tests must be maintained alongside implementation changes. Every behavior change should include or update relevant tests.
- Preserve the HealthSave client-facing API contract unless an explicit planning decision changes it.

## 2) Project Goal

Build a production-ready drop-in replacement server for HealthSave-compatible sync clients.

The replacement server must:

- accept the same HTTP requests as the reference server,
- preserve optional `x-api-key` authentication behavior,
- publish incoming health data to MQTT,
- normalize data into stable metric-specific event shapes,
- keep enough local state for status counts and idempotency,
- optionally validate behavior against the TimescaleDB reference implementation,
- run reproducibly in Docker.

## 3) Source of Truth

### 3.1 Reference Implementation

The reference implementation lives in:

```text
reference-implementation/
```

It contains the original FastAPI + TimescaleDB server and schema. It is only a behavioral reference for:

- endpoint paths,
- request and response shapes,
- API-key behavior,
- metric routing,
- field mappings,
- status counter names,
- idempotency/upsert intent,
- Docker/self-hosting expectations.

Do not use the reference implementation as the runtime target. The new service should be implemented outside that directory.

### 3.2 Documentation Split

| File | Audience | Purpose |
| --- | --- | --- |
| `README.md` | Users/operators/integrators | Explain purpose, usage, options, deployment model |
| `PORTING.md` | Maintainers/implementers | Track porting plan, compatibility details, rollout, decisions |
| `AGENTS.md` | Coding agents/maintainers | Define working rules and repository guardrails |
| `TEST_STRATEGY.md` | Maintainers/implementers | Define the test approach and testing layers |
| `TEST_MATRIX.md` | Maintainers/implementers | Track existing, planned, and blocked tests |
| `CHANGELOG.md` | Users/maintainers | Track changes under the `package.json` version |

## 4) Compatibility Contract

### 4.1 Required Endpoints

| Endpoint | Method | Required response/behavior |
| --- | --- | --- |
| `/health` | GET | Return `{"status":"ok"}` |
| `/api/health` | GET | Return `{"status":"ok"}` |
| `/api/apple/batch` | POST | Receive and process one metric batch |
| `/api/apple/status` | GET | Return status counters in reference-compatible shape |

### 4.2 Authentication

The reference behavior is intentionally simple:

- If `API_KEY` is empty or unset, requests are accepted without `x-api-key`.
- If `API_KEY` is set, requests must include the matching `x-api-key` header.
- Invalid keys return HTTP `401`.

This must apply to:

- `POST /api/apple/batch`
- `GET /api/apple/status`

Health endpoints should remain unauthenticated unless we explicitly decide otherwise.

### 4.3 Status Response

`GET /api/apple/status` must return the known counter keys even when counts are zero:

```json
{
  "status": "ok",
  "counts": {
    "heart_rate": 0,
    "hrv": 0,
    "blood_oxygen": 0,
    "daily_activity": 0,
    "sleep_sessions": 0,
    "workouts": 0,
    "quantity_samples": 0
  }
}
```

Counters should represent accepted/processed logical records, not necessarily retained MQTT messages.

## 5) Batch API Contract

### 5.1 Request Shape

`POST /api/apple/batch` receives JSON:

```json
{
  "metric": "heart_rate",
  "batch_index": 0,
  "total_batches": 1,
  "samples": [
    {
      "date": "2026-04-10T12:00:00Z",
      "qty": 72,
      "source": "Apple Watch"
    }
  ]
}
```

Fields:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `metric` | string | `unknown` in reference | Metric routing key |
| `batch_index` | number | `0` | Zero-based batch index |
| `total_batches` | number | `1` | Total batch count for current sync |
| `samples` | object array | `[]` | Metric-specific samples |

### 5.2 Empty Response

If `samples` is empty or absent:

```json
{
  "status": "empty",
  "metric": "heart_rate",
  "batch": 0,
  "records": 0
}
```

### 5.3 Processed Response

After successful processing:

```json
{
  "status": "processed",
  "metric": "heart_rate",
  "batch": 0,
  "total_batches": 1,
  "records": 12
}
```

`records` should count samples that were valid enough to process, after metric-specific filtering and deduplication rules.

## 6) Metric Routing and Mapping

The new server should preserve the reference routing categories.

### 6.1 Dedicated Metrics

| Incoming metric | Logical counter/table | Required fields | Notes |
| --- | --- | --- | --- |
| `heart_rate` | `heart_rate` | `date`, `qty` | Map `qty` to `bpm`, `source` to `source_id` |
| `heart_rate_variability` | `hrv` | `date`, `qty` | Map `qty` to `value_ms`, default algorithm `sdnn` |
| `blood_oxygen` | `blood_oxygen` | `date`, `qty` | Map `qty` to `spo2_pct` |
| `body_temperature` | optional dedicated normalized metric | `date`, `qty` | Reference has a table, status response does not include a counter key |

### 6.2 Activity Summaries

Incoming metric:

```text
activity_summaries
```

Logical counter:

```text
daily_activity
```

Field mappings from the reference:

| Source field | Normalized field |
| --- | --- |
| `steps` | `steps` |
| `distance` | `distance_m` |
| `flights_climbed` | `floors_climbed` |
| `active_energy` | `active_calories` |
| `activeEnergyBurned` | `active_calories` |
| `basal_energy` | `total_calories` |
| `exercise_minutes` | `active_minutes` |
| `appleExerciseTime` | `active_minutes` |
| `stand_hours` | `stand_hours` |
| `appleStandHours` | `stand_hours` |

### 6.3 Sleep Analysis

Incoming metric:

```text
sleep_analysis
```

Logical counter:

```text
sleep_sessions
```

Reference behavior:

- Accepts stage-style samples with `startDate`, `endDate`, and `value`.
- Also accepts pre-aggregated session-style samples with `start_date`, `end_date`, `total_duration_ms`, `deep_ms`, `rem_ms`, `light_ms`/`core_ms`, `awake_ms`, and `respiratory_rate`.
- Aggregates stage samples into sessions when gaps are less than or equal to 4 hours.
- Buckets stages:
  - `deep` -> `deep_ms`
  - `rem` -> `rem_ms`
  - `awake` -> `awake_ms`
  - `core`, `light`, `asleep`, `asleep unspecified` -> `light_ms`

Open planning question: whether the MQTT-first implementation should strictly reproduce sleep session aggregation or publish raw stages plus a minimal normalized session event.

### 6.4 Workouts

Incoming metric:

```text
workouts
```

Logical counter:

```text
workouts
```

Reference-compatible fields:

| Normalized field | Accepted source fields |
| --- | --- |
| `start_time` | `start_date`, `startDate`, `start`, `date` |
| `end_time` | `end_date`, `endDate`, `end` |
| `sport_type` | `sport_type`, `sportType`, `name` |
| `duration_ms` | `duration_ms`, or `duration` converted from seconds |
| `avg_hr` | `avg_hr`, `avgHeartRate` |
| `max_hr` | `max_hr`, `maxHeartRate` |
| `calories` | `calories`, `activeEnergy` |
| `distance_m` | `distance_m`, `distance` |

Open planning question: whether workout events should be deduplicated even though the reference does not strictly enforce this.

### 6.5 Generic Quantity Metrics

All unknown metrics should follow `quantity_samples` semantics:

| Source field | Normalized field |
| --- | --- |
| `date` | `time` |
| `qty` | `value` |
| `unit` | `unit` |
| `source` | `source_id` |
| incoming `metric` | `metric_name` |

## 7) Target Architecture

### 7.1 Runtime and Frameworks

Use the current active Node.js LTS at implementation time and maintained framework versions.

Recommended stack:

- Node.js active LTS
- TypeScript
- Fastify for HTTP routing
- `mqtt` for MQTT client integration
- `zod` or equivalent schema validation
- `pino` for structured logging
- SQLite via `better-sqlite3` for default local state
- Redis as an optional future state backend for horizontal scaling
- Vitest or Node's built-in test runner for unit tests
- Supertest or Fastify injection for API tests
- Testcontainers for MQTT integration tests where practical

### 7.2 Module Layout

Planned structure:

```text
src/
  server.ts
  config.ts
  auth.ts
  routes/
    health.ts
    apple.ts
  ingest/
    router.ts
    schemas.ts
    mappers/
      heart-rate.ts
      hrv.ts
      blood-oxygen.ts
      activity.ts
      sleep.ts
      workouts.ts
      quantity.ts
  mqtt/
    publisher.ts
    topics.ts
  state/
    store.ts
    sqlite-store.ts
  storage/
    raw-batch-storage.ts
  compat/
    timescale.ts
test/
  unit/
  integration/
  replay/
config/
  topic-map.example.json
Dockerfile
docker-compose.yml
```

This structure can change if implementation reveals a simpler local pattern.

## 8) Data Flow

1. HealthSave sends `POST /api/apple/batch`.
2. Auth middleware validates `x-api-key` when configured.
3. Request schema validation accepts known and permissive client fields.
4. Ingest router selects the metric mapper.
5. Mapper parses timestamps/dates and normalizes fields.
6. Non-empty valid raw batches are optionally archived to local NDJSON storage.
7. Idempotency layer filters duplicates where enabled.
8. MQTT publisher emits raw, normalized, and current events using the active client context.
9. State store updates logical counters.
10. Optional Timescale reference mode performs shadow write or comparison.
11. API returns the reference-compatible response.

## 9) MQTT Plan

### 9.1 Default Topics

| Event kind | Default topic |
| --- | --- |
| Raw sample | `healthsave/raw/{metric}` |
| Normalized sample | `healthsave/normalized/{metric}` |
| Current scalar value | `healthsave/current/{metric}` |
| Sync status | `healthsave/status/sync` |

### 9.2 Payload Requirements

Every MQTT event should include:

- `metric`
- `event_type`
- `ingested_at`
- `batch_index`
- `total_batches`
- `device_id`
- `idempotency_key`
- raw `sample` or `normalized_sample`

Raw events preserve source fields where possible. Normalized events provide stable field names for consumers.

### 9.3 Multi-Client Contexts

The root URL is always registered as the `default` context. Additional contexts can register URL prefixes such as:

```text
/daniel
/alice
```

Clients configured with `http://host:8000/daniel` still send the reference API paths under that prefix:

```text
/daniel/api/apple/batch
/daniel/api/apple/status
```

Each context owns topic templates and status counters. Topic templates support both `{metric}` and `{context}` placeholders.

Example YAML:

```yaml
contexts:
  - name: "daniel"
    prefix: "/daniel"
    topics:
      raw: "healthsave/daniel/raw/{metric}"
      normalized: "healthsave/daniel/normalized/{metric}"
      current: "healthsave/daniel/current/{metric}"
```

## 10) Configuration Plan

### 10.1 Core

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP bind host |
| `PORT` | `8000` | Match reference default |
| `API_KEY` | empty | Empty disables API-key enforcement |
| `LOG_ENABLED` | `true` | Debuggability first |
| `LOG_LEVEL` | `info` | Standard production default |

### 10.2 MQTT

| Variable | Default |
| --- | --- |
| `MQTT_ENABLED` | `true` |
| `MQTT_URL` | `mqtt://broker:1883` |
| `MQTT_CLIENT_ID` | `healthsave-proxy` |
| `MQTT_USERNAME` | empty |
| `MQTT_PASSWORD` | empty |
| `MQTT_QOS` | `1` |
| `MQTT_RETAIN` | `false` |
| `MQTT_TOPIC_RAW` | `healthsave/raw/{metric}` |
| `MQTT_TOPIC_NORMALIZED` | `healthsave/normalized/{metric}` |
| `MQTT_TOPIC_CURRENT` | `healthsave/current/{metric}` |
| `CONTEXTS` | empty JSON array |

### 10.3 State

| Variable | Default |
| --- | --- |
| `STATE_BACKEND` | `sqlite` |
| `SQLITE_PATH` | `/data/state.db` |
| `IDEMPOTENCY_ENABLED` | `true` |
| `IDEMPOTENCY_WINDOW_DAYS` | `30` |

### 10.4 Raw Batch Storage

| Variable | Default | Notes |
| --- | --- | --- |
| `RAW_STORAGE_PATH` | empty | Optional raw NDJSON archive path. Empty disables raw storage. |

When enabled, non-empty valid batch requests are appended before MQTT publication to:

```text
<RAW_STORAGE_PATH>/<context>/yyyy-mm
```

Each line preserves the parsed request body with minimal context, metric, batch, and ingestion metadata. Empty batches are skipped. Archive write failures reject the request before MQTT publishing or status counter updates.

### 10.5 Timescale Reference Mode

| Variable | Default | Notes |
| --- | --- | --- |
| `TIMESCALE_MODE` | `off` | `off`, `shadow`, or `bridge` |
| `TIMESCALE_URL` | empty | PostgreSQL connection string |
| `TIMESCALE_STRICT_STARTUP` | `false` | Fail startup if reference handshake fails |

## 11) Timescale Reference Modes

Reference mode is optional and only exists to reduce migration risk.

| Mode | Behavior |
| --- | --- |
| `off` | No Timescale interaction |
| `shadow` | Publish MQTT and optionally write reference-compatible rows to Timescale |
| `bridge` | Use Timescale/reference behavior for comparison or diagnostics while MQTT remains the operational output |

Startup behavior:

- Test DB connection with a minimal query when reference mode is enabled.
- Optionally verify expected reference tables exist.
- If strict startup is enabled, fail startup on reference handshake failure.
- Otherwise log a warning and continue without reference writes/comparison.

## 12) Docker and Self-Hosting

Self-hosting is part of the core deliverable.

Required files:

- `Dockerfile`
- `docker-compose.yml`
- `.env.example`
- optional config examples under `config/`

Docker requirements:

- multi-stage build,
- non-root runtime user,
- healthcheck against `/health`,
- persistent `/data` volume for SQLite state,
- optional raw batch archive under `/data/raw`,
- service examples for API and MQTT broker,
- optional TimescaleDB service for reference validation.

## 13) Testing Strategy

Tests are required with implementation changes.

### 13.1 Unit Tests

Cover:

- timestamp parsing,
- date parsing,
- metric mappers,
- topic rendering,
- idempotency key generation,
- auth behavior,
- config parsing.

### 13.2 API Integration Tests

Cover:

- `GET /health`,
- `GET /api/health`,
- `POST /api/apple/batch` happy path,
- empty batch response,
- status counters,
- incorrect API key returns `401`,
- no configured API key accepts missing header.

### 13.3 MQTT Integration Tests

Cover:

- raw event publication,
- normalized event publication,
- configured topics,
- QoS and retain settings,
- MQTT-disabled behavior.

### 13.4 Raw Storage Tests

Cover:

- raw archive config parsing,
- newline-delimited batch append behavior,
- context and month file layout,
- storage failure behavior before MQTT and status updates.

### 13.5 Replay Tests

Create realistic replay fixtures with:

- multiple metric types,
- out-of-order batches,
- duplicate samples,
- unknown metrics,
- large batches,
- mixed timestamp formats,
- older/permissive client fields.

## 14) Rollout Plan

### Phase A: Compatibility Skeleton

- Implement health endpoints. Status: initial scaffold complete.
- Implement API-key middleware. Status: initial scaffold complete.
- Implement batch endpoint with schema validation. Status: initial scaffold complete.
- Implement status endpoint with zero counters. Status: initial scaffold complete.
- Add API compatibility tests. Status: initial scaffold complete.

### Phase B: MQTT Publishing

- Add MQTT publisher. Status: initial raw publisher complete.
- Add topic template rendering. Status: initial scaffold complete.
- Publish raw events. Status: initial raw sample events complete.
- Add MQTT tests. Status: initial publisher and API publish-path tests complete.

### Phase C: Metric Normalization

- Implement dedicated metric mappers. Status: initial reference-compatible extraction complete.
- Implement activity, sleep, workout, and generic fallback mappers. Status: initial reference-compatible extraction complete.
- Publish normalized events. Status: initial normalized MQTT events complete.
- Add mapper and replay tests. Status: mapper tests and raw batch archive tests complete; replay fixtures still planned.

### Phase D: State and Idempotency

- Add SQLite state store.
- Track logical counters.
- Add idempotency keys and retention.
- Add optional raw batch archive. Status: initial NDJSON archive complete for non-empty valid batches.
- Add duplicate replay tests.

### Phase E: Reference Validation

- Add optional Timescale connection.
- Add shadow/bridge validation where useful.
- Compare response counts and mapper behavior against reference expectations.

### Phase F: Production Packaging

- Add Dockerfile. Status: initial scaffold complete.
- Add docker-compose.yml. Status: initial scaffold complete.
- Add `.env.example`. Status: initial scaffold complete.
- Document deployment and options in `README.md`. Status: initial scaffold complete.

## 15) Acceptance Criteria

- HealthSave can sync without app changes.
- Required endpoints and response shapes match the reference contract.
- Optional `x-api-key` behavior matches the reference contract.
- MQTT contains all relevant accepted samples.
- Normalized events are stable enough for downstream consumers.
- Status counters are plausible and consistent.
- Logs are enabled by default and redact sensitive values.
- Docker self-hosting works with a broker and persistent state.
- Tests cover compatibility, mapping, MQTT publishing, and replay behavior.
- `reference-implementation/` remains unchanged.

## 16) Open Decisions

1. Should sleep analysis strictly reproduce reference session aggregation, or should MQTT publish raw stages plus minimal normalized sessions?
2. Should workouts be deduplicated even though the reference does not strictly enforce deduplication?
3. Should MQTT messages support signing or encryption beyond broker-level TLS/auth?
4. Is Redis needed for horizontal scaling in the first implementation, or should SQLite remain the only initial state backend?
5. Should invalid samples be reported only through logs, or should batch responses include skipped counts?
6. Should `body_temperature` receive a status counter even though the reference status response does not include one?
7. Should retained MQTT messages be allowed per metric or only globally configured?
