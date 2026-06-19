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
| `/ready` | GET | Return reference-compatible readiness for local state writability |
| `/api/apple/batch` | POST | Receive and process one metric batch |
| `/api/apple/status` | GET | Return flat status objects in reference-compatible shape |
| `/metrics` | GET | Return Prometheus exposition with reference metric names |
| `/api/insights/latest` | GET | Return latest insight response shape; MQTT bridge returns no-data stubs |
| `/api/insights/daily` | GET | Return daily briefing shape; MQTT bridge returns an empty briefing |
| `/api/insights/weekly` | GET | Return weekly summary shape; MQTT bridge returns an empty summary |
| `/api/insights/anomalies` | GET | Return anomaly list shape with reference query validation |
| `/api/insights/trends` | GET | Return trend list shape with reference query validation |
| `/api/insights/trigger` | POST | Return trigger response shape; MQTT bridge returns skipped for supported jobs |
| `/api/insights/runs` | GET | Return analysis run list shape; MQTT bridge returns an empty list |
| `/api/v2/setup/diagnostics` | GET | Return unauthenticated setup diagnostics for API base URL checks |
| `/api/v2/sync/runs/latest` | GET | Return the latest sync delivery receipt, or an empty success response before any sync-run receipt exists |
| `/api/v2/sync/runs/{sync_run_id}` | GET | Return one run-specific delivery receipt summary |
| `/api/v2/sync/coverage` | GET | Return metric-level sync receipt coverage |

### 4.2 Authentication

The reference behavior is intentionally simple:

- If `API_KEY` is empty or unset, requests are accepted without `x-api-key`.
- If `API_KEY` is set, requests must include the matching `x-api-key` header.
- Invalid keys return HTTP `401`.

This must apply to:

- `POST /api/apple/batch`
- `GET /api/apple/status`
- `GET /api/insights/latest`
- `GET /api/insights/daily`
- `GET /api/insights/weekly`
- `GET /api/insights/anomalies`
- `GET /api/insights/trends`
- `POST /api/insights/trigger`
- `GET /api/insights/runs`
- `GET /api/v2/sync/runs/latest`
- `GET /api/v2/sync/runs/{sync_run_id}`
- `GET /api/v2/sync/coverage`

Health, readiness, and setup diagnostics endpoints remain unauthenticated. This satisfies
HealthSave 1.5 liveness behavior, which checks `/api/health` first and accepts
`/health` as a fallback.

`GET /api/v2/sync/runs/latest` returns HTTP `200` with `status: "empty"` when
the endpoint is available but no `X-HealthSave-Sync-Run-ID` receipt has been
recorded yet. Specific unknown run IDs still return HTTP `404` from
`GET /api/v2/sync/runs/{sync_run_id}`.

### 4.3 Status Response

`GET /api/apple/status` must return a flat object whose top-level keys are the
known HealthSave status metrics, even when they are empty:

```json
{
  "heart_rate": { "count": 0, "oldest": null, "newest": null },
  "hrv": { "count": 0, "oldest": null, "newest": null },
  "blood_oxygen": { "count": 0, "oldest": null, "newest": null },
  "daily_activity": { "count": 0, "oldest": null, "newest": null },
  "sleep_sessions": { "count": 0, "oldest": null, "newest": null },
  "workouts": { "count": 0, "oldest": null, "newest": null },
  "quantity_samples": { "count": 0, "oldest": null, "newest": null }
}
```

Status values should represent deduplicated logical records, not request
volume or retained MQTT messages.

Status timestamps currently return ISO UTC strings, for example
`2026-04-10T12:00:00.000Z`, while `daily_activity` returns date-only values.
This is intentional: the API compatibility notes accept ISO 8601 timestamps with
a trailing `Z`, and keeping the same format in ledgers, MQTT payloads, and API
responses avoids migration churn.

### 4.4 Insight Compatibility

`/api/insights/*` routes are part of the frozen reference V1 route inventory.
The MQTT bridge serves the reference response shapes and query validation, but
does not claim to run the Data Hub analysis engine. Insight reads return empty
or no-data shapes, and supported trigger requests return a skipped no-op
response.

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
  "total_batches": 1,
  "records": 0,
  "receipt_id": "runless:heart_rate:0",
  "sync_run_id": null,
  "batch_id": null,
  "idempotency_key": null,
  "batch_index": 0,
  "records_received": 0,
  "records_accepted": 0,
  "records_rejected": 0,
  "records_inserted_new": null,
  "records_deduped_existing": null,
  "records_deduped_in_batch": null,
  "storage_result_level": "accepted_only",
  "sample_window": {
    "min_sample_time": null,
    "max_sample_time": null
  },
  "verification_level": "delivery_receipt",
  "per_metric": {
    "heart_rate": {
      "received": 0,
      "accepted": 0,
      "rejected": 0,
      "inserted_new": null,
      "deduped_existing": null,
      "deduped_in_batch": null,
      "sample_window": {
        "min_sample_time": null,
        "max_sample_time": null
      }
    }
  }
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
  "records": 12,
  "receipt_id": "runless:heart_rate:0",
  "records_received": 12,
  "records_accepted": 12,
  "records_rejected": 0,
  "records_deduped_in_batch": 0,
  "storage_result_level": "accepted_only",
  "sample_window": {
    "min_sample_time": "2026-04-10T12:00:00Z",
    "max_sample_time": "2026-04-10T12:05:00Z"
  },
  "verification_level": "delivery_receipt"
}
```

`records` should count valid deduplicated logical records after metric-specific
filtering and routing. Non-empty batches with no valid logical records still
return `"status": "processed"` with `"records": 0`.

The response keeps the legacy fields and adds the reference delivery receipt
fields. `records_inserted_new` and `records_deduped_existing` are `null`
because this MQTT-first bridge does not know Timescale insert-vs-existing
upsert outcomes.

### 5.4 Receipt Headers, Idempotency, and Sample Windows

HealthSave receipt headers are captured when present. The idempotency key is
resolved in reference order: explicit `Idempotency-Key`, then
`X-HealthSave-Batch-ID`, then `X-HealthSave-Sync-Run-ID` combined with metric
and batch index. Matching retries replay the first successful response without
publishing MQTT messages or updating status again. A reused key with a different
non-empty `X-HealthSave-Payload-Hash` returns `409` with
`detail.error_code: "idempotency_key_payload_mismatch"`.

`sample_window` is taken from `X-HealthSave-Sample-Min-Time` and
`X-HealthSave-Sample-Max-Time` when either header is present. Malformed header
timestamps become `null`. When headers are absent, the service derives the
window from sample start/end fields using the reference key precedence.

## 6) Metric Routing and Mapping

The new server should preserve the reference routing categories.

### 6.1 Dedicated Metrics

| Incoming metric | Logical counter/table | Required fields | Notes |
| --- | --- | --- | --- |
| `heart_rate` | `heart_rate` | `date`, `qty` | Map `qty` to `bpm`, `source` to `source_id` |
| `heart_rate_variability` | `hrv` | `date`, `qty` | Map `qty` to `value_ms`, default algorithm `sdnn` |
| `blood_oxygen` | `blood_oxygen` | `date`/`startDate`, `qty`/`oxygenSaturation`/`spo2`/`value` | Map value to `spo2_pct`; fractional values like `0.97` are converted to percent |
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

Daily quantity metrics also map into `daily_activity`:

| Incoming metric | Normalized field |
| --- | --- |
| `step_count` | `steps` |
| `distance_walking_running` | `distance_m` |
| `flights_climbed` | `floors_climbed` |
| `active_energy_burned` | `active_calories` |
| `basal_energy_burned` | `total_calories` |
| `apple_exercise_time` | `active_minutes` |

The reference keeps `apple_stand_time`, `distance_cycling`, and
`distance_wheelchair` in `quantity_samples`.

Current MQTT values for `daily_activity` fan out per normalized field so
consumers can subscribe to scalar topics such as
`healthsave/current/daily_activity/steps`,
`healthsave/current/daily_activity/active_calories`, or
`healthsave/current/daily_activity/stand_hours`.

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
- Adds normalized `awake` from the latest stage in the session and publishes it as the `sleep_sessions` current MQTT value.

Open planning question: whether the MQTT-first implementation should strictly reproduce sleep session aggregation or publish raw stages plus a minimal normalized session event.

### 6.4 Workouts

Incoming metric:

```text
workouts
workout
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
| `calories` | `calories`, `activeEnergy`, `activeEnergyBurned` |
| `distance_m` | `distance_m`, `distance` |

Workout session records publish current MQTT values from normalized `calories`. HealthSave can also send daily activity-style active energy samples as `workout` or as `workouts` without `endDate`/`end_date`; those samples are normalized as scalar `quantity_samples` records using `activeEnergyBurned` as the kilocalorie value so normalized and current MQTT topics still receive data.

### 6.5 Generic Quantity Metrics

All unknown metrics should follow `quantity_samples` semantics:

| Source field | Normalized field |
| --- | --- |
| `date` | `time` |
| `qty` | `value` |
| `unit` | `unit` |
| `source` | `source_id` |
| incoming `metric` | `metric_name` |

### 6.6 Unknown Data Diagnostics

The mapper should keep accepting batches even when the client sends a metric or
sample field shape that is not implemented yet. In that case, ingest emits a
structured warning log with an `unknown_health_data` object instead of requiring
full raw-body trace logging.

The diagnostic object should include:

- batch context, metric, batch index, total batches, raw record count, and
  processed record count,
- whether the metric used the generic fallback or a dedicated mapper,
- reasons such as `unsupported_metric`, `unmapped_sample_fields`, or
  `rejected_sample`,
- aggregate field summaries for sample keys, unmapped keys, candidate timestamp
  fields, candidate numeric value fields, candidate string fields, and source
  IDs,
- implementation hints naming the metric and likely timestamp/value fields,
- a bounded list of sanitized sample examples.

This is intentionally additive to the HealthSave API response contract. Clients
still receive the same accepted/empty/error response shapes, while maintainers
can copy the JSON warning from normal logs and turn it into a mapper test plus a
new MQTT normalization rule.

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
7. Dedicated idempotency index replays already accepted matching retry keys
   derived from `Idempotency-Key`, `X-HealthSave-Batch-ID`, or sync-run
   fallback metadata, and rejects conflicting payload hashes.
8. MQTT publisher emits raw, normalized, and current events using the active client context.
9. State store updates logical counters.
10. Sync receipt store records run metadata and accepted/rejected/deduped counts
    when `X-HealthSave-Sync-Run-ID` is present.
11. Optional Timescale reference mode performs shadow write or comparison.
12. API returns the reference-compatible response.

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

For `quantity_samples`, MQTT topic selection uses the normalized `metric_name`
field so correlated payloads such as blood pressure publish to
`.../blood_pressure_systolic` and `.../blood_pressure_diastolic` instead of the
outer batch metric. Current-value topics may also include field subpaths for
multi-value records, such as `daily_activity/steps`, `sleep_sessions/awake`, or
`workouts/distance_m`.

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

Each context owns topic templates and a separate status ledger. Topic templates support both `{metric}` and `{context}` placeholders.

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
| `HTTP_BODY_LIMIT_BYTES` | `524288000` | 500 MiB parser limit for large HealthSave sync batches |
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
| `DATA_PATH` | `/data` |
| `STATE_BACKEND` | `file` |

The current durable state backend stores deduplicated `/api/apple/status`
observations in SQLite under `<DATA_PATH>/status/status.sqlite`. The database
keeps exact dedupe rows plus aggregate `count`, `oldest`, and `newest` values so
HealthSave clients can read status after restarts without loading all historical
identities into memory.

On first startup after upgrading from the legacy status ledger, existing
`<DATA_PATH>/status/<context>/observations.ndjson` files are migrated into
SQLite and then renamed to `observations.ndjson.migrated` so they are not picked
up by later forced or remedial migration scans. Startup logs report the selected
state backend, SQLite database path, schema initialization, whether migration
ran or was skipped, per-context migration counts, skipped malformed rows,
renamed legacy ledgers, and a final migration summary. SQLite may create
`status.sqlite-wal` and `status.sqlite-shm` beside the main database file; all
`status.sqlite*` files are part of the durable status state.

The same backend also stores lightweight sync delivery receipts under
`<DATA_PATH>/receipts/<context>/receipts.ndjson` when clients send
`X-HealthSave-Sync-Run-ID`. These records contain sync metadata and counts, not
raw health samples.

Idempotency entries are stored separately under
`<DATA_PATH>/idempotency/<context>/keys.ndjson` for every successful batch with
a reference-derived retry key. Matching retry key plus payload hash requests
replay the original response without repeating raw storage, MQTT publication, or
status updates. Reusing the same key with a different payload hash returns
`409`.
`STATE_BACKEND=memory` remains available for disposable local runs and tests.

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
- persistent `/data` volume for local state,
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
- SQLite-backed status state persistence and legacy NDJSON migration,
- sync receipt header parsing and idempotency replay metadata,
- auth behavior,
- config parsing.

### 13.2 API Integration Tests

Cover:

- `GET /health`,
- `GET /api/health`,
- `POST /api/apple/batch` happy path,
- empty batch response,
- flat status reporting,
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

- Add file-backed local status state. Status: SQLite-backed status store with legacy NDJSON migration complete.
- Track logical counters. Status: flat `count` / `oldest` / `newest` status objects complete.
- Add HealthSave retry idempotency. Status: complete for all successful batches
  with explicit `Idempotency-Key`, `X-HealthSave-Batch-ID`, or sync-run fallback
  metadata, independent of v2 sync receipt summaries.
- Add broader deterministic record-key idempotency and retention. Status: planned.
- Add optional raw batch archive. Status: initial NDJSON archive complete for non-empty valid batches.
- Add duplicate replay tests. Status: explicit and fallback retry replay/conflict tests complete.

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
2. Should MQTT messages support signing or encryption beyond broker-level TLS/auth?
3. Is Redis needed for horizontal scaling in the first implementation, or should SQLite remain the only initial state backend?
4. Should retained MQTT messages be allowed per metric or only globally configured?
