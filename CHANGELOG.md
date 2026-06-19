# Changelog

All notable changes to this project will be documented in this file.

Version headers must match the `version` field in `package.json`.

## 0.4.1

### Changed

- Updated npm dependencies to resolve audit advisories in Fastify, Vitest, and transitive URI, IP address, and WebSocket packages.
- Changed `GET /ready` success responses to the updated reference shape with `status: "ready"`.
- Changed the test script to run source tests from `test/` directly so stale compiled `dist/test` files cannot shadow current tests.
- Changed v2 sync coverage responses to include a summary envelope, receipt sample windows, and destination row counts.
- Changed the file-backed `/api/apple/status` store from per-context NDJSON ledgers to a SQLite database at `<DATA_PATH>/status/status.sqlite`.
- Changed `unknown_health_data` warning logs to schema v2 with redacted field profiles and mapper-ready hints instead of raw sample values.

### Added

- Added the expanded `/api/v2` API reference surface, including meta, metric catalog, series reads, identity, readiness, changes, receipts, export, privacy, intelligence, experiments, agents, sync anomalies, and the Whoop webhook route.
- Added a lightweight local read-state SQLite store under `<DATA_PATH>/read/read.sqlite` for normalized observations, Source/Device/Stream identity, intelligence audit/settings, and experiment records.
- Added a local API reference endpoint inventory used by tests to assert open, keyed, and HMAC route classification.
- Added optional `WHOOP_WEBHOOK_SECRET` configuration and HMAC verification for `/api/v2/sources/whoop/webhook`.
- Added tests for v2 read APIs, identity, export JSON/CSV, ETag change polling, receipts, empty/no-op higher-level surfaces, experiments, intelligence/privacy posture, and Whoop webhook signatures.
- Added automatic one-time migration from legacy `<DATA_PATH>/status/<context>/observations.ndjson` status ledgers into SQLite, then renaming processed ledgers to `observations.ndjson.migrated`.
- Added startup and migration logs for the selected state backend, SQLite schema initialization, per-context migration counts, skipped malformed legacy rows, and final migration summaries.
- Added tests for SQLite status persistence, exact dedupe, legacy migration, migration marker skipping, close readiness, and startup failure when SQLite cannot open.
- Added structured `unknown_health_data` warning logs for unsupported metrics, rejected samples, and unmapped sample fields, including candidate mapper fields and redacted sample field profiles.
- Added documentation and tests for unknown health data diagnostics so new client payload shapes can be implemented from normal logs.
- Added explicit support for logged HealthSave quantity metrics including resting heart rate, walking dynamics, physical effort, environmental audio exposure, time in daylight, and handwashing events without unsupported-metric diagnostics.
- Added activity summary goal fields for active calories, exercise minutes, and stand hours, including normalized MQTT current topics and v2 catalog entries.

## 0.4.0

### Added

- Added the frozen reference V1 `/metrics` and `/api/insights/*` route surface with reference-shaped no-data responses.
- Added reference delivery receipt fields to `POST /api/apple/batch` responses, including receipt IDs, accepted/rejected counts, sample windows, and per-metric summaries.
- Added idempotency fallback handling for `X-HealthSave-Batch-ID` and sync-run-derived retry keys.
- Added tests for the full V1 route inventory, insight stubs, batch validation errors, sample-window handling, delivery receipts, and fallback idempotency replay.
- Added a dedicated file and memory idempotency index for all successful batches with `Idempotency-Key`, including batches without sync-run receipt headers.
- Added `GET /ready` readiness checks for local state writability.
- Added failed-batch sync receipt rows so v2 run summaries report processed and failed batch counts separately.
- Added ECG compatibility handling and category-event timestamp fallbacks for generic quantity ingestion.
- Added tests for idempotency persistence, readiness probes, failed receipt summaries, ECG compatibility, and category-event fallback timestamps.

### Changed

- Changed `GET /ready` to follow the reference V1 state-only readiness contract.
- Changed batch validation responses to use reference-style invalid JSON `400` and schema validation `422` bodies.
- Changed retry conflict responses to use the reference `detail.error_code` shape.
- Changed sync receipt accounting to keep delivery receipts scoped to `X-HealthSave-Sync-Run-ID` while idempotency replay is handled by the new dedicated index.
- Changed `GET /api/v2/sync/runs/latest` to return a `200` empty-state response before any sync-run receipt exists, while keeping specific unknown run IDs as `404`.
- Documented `/api/insights/*` as reference-shaped compatibility stubs and kept status timestamps as ISO UTC strings for API compatibility.

## 0.3.0

### Changed

- Bumped the app version to 0.3.0.
- Changed ingest normalization to expose accepted, rejected, and in-batch deduped record counts for sync receipt accounting.

### Added

- Added unauthenticated `GET /api/v2/setup/diagnostics` for HealthSave setup checks.
- Added protected `GET /api/v2/sync/runs/latest`, `GET /api/v2/sync/runs/{sync_run_id}`, and `GET /api/v2/sync/coverage` delivery receipt endpoints.
- Added memory and file-backed sync receipt storage under `<DATA_PATH>/receipts/<context>/receipts.ndjson`.
- Added HealthSave receipt header capture plus idempotency replay/conflict handling for matching `Idempotency-Key` and payload hash values.
- Added tests for v2 diagnostics, sync receipts, receipt coverage, prefixed receipt isolation, and idempotency replay/conflict behavior.

## 0.2.0

### Changed

- Bumped the app version to 0.2.0.
- Changed `GET /api/apple/status` to return flat per-metric status objects with `count`, `oldest`, and `newest`.
- Changed batch `records` reporting to count valid deduplicated logical records and return `0` for non-empty batches whose samples are all invalid.
- Changed daily quantity routing so `step_count`, `distance_walking_running`, `flights_climbed`, `active_energy_burned`, `basal_energy_burned`, and `apple_exercise_time` normalize into `daily_activity`.
- Changed device identity extraction to honor the broader HealthSave source and device field aliases with a `HealthSave` fallback.
- Changed MQTT quantity-sample topic routing to use the normalized per-sample `metric_name` so correlated metrics publish to distinct topics.
- Changed current MQTT publication to fan out multi-field records like `daily_activity`, `sleep_sessions`, and `workouts` into field-specific subtopics while keeping legacy top-level sleep and workout topics.

### Added

- Added a deduplicated file-backed status ledger under `<DATA_PATH>/status/<context>/observations.ndjson`.
- Added coverage for flat status responses, duplicate-retry deduplication, blood-pressure subtype counting, body-temperature status exclusion, and daily-activity quantity routing.
- Added regression coverage for complete daily-activity mapping matrices, wrapped raw batch archive preservation, and end-to-end MQTT topic exports for wrapped step and blood-pressure payloads.
- Added documentation for the new status response shape, persistence layout, and upgrade expectation from the old counter-only state file.

## 0.1.0

### Added

- Added the initial Node.js + TypeScript Fastify server scaffold.
- Added HealthSave-compatible health, batch, and status endpoints.
- Added reference-compatible optional API-key behavior.
- Added in-memory status counters for the initial compatibility scaffold.
- Added Dockerfile and Docker Compose self-hosting setup with Mosquitto.
- Added commented default environment templates.
- Added a commented local YAML configuration file template for plain `npm start` runs.
- Added local config file loading with environment variable override behavior.
- Added `npm run start:local` for local development config files.
- Fixed npm start scripts to use the built server entrypoint.
- Expanded README guidance for local development configuration.
- Removed manual SpecStory requirements from agent commit instructions.
- Documented that external tooling manages `.specstory/` and generated changes may be committed.
- Added initial MQTT topic rendering helper.
- Added raw MQTT publishing for non-empty HealthSave batch samples.
- Added reference-compatible datapoint extraction for dedicated metrics, generic quantities, activity summaries, sleep sessions, and workouts.
- Added blood oxygen normalization aliases for HealthKit-style saturation fields.
- Added workout active-energy normalization and current values using `activeEnergy`, `activeEnergyBurned`, or `calories`.
- Added sleep awake-state current values from the latest sleep stage.
- Added normalized MQTT publishing for accepted datapoints.
- Added scalar current MQTT topics for datapoints with one primary value.
- Added multi-client contexts with configurable URL prefixes, per-context MQTT topics, and isolated status counters.
- Added JSON wrapper deserialization for encoded batch and sample data.
- Added batch-level debug logging for incoming body keys, metrics, sample keys, counter routing, and MQTT publish counts.
- Added `502` handling for MQTT publish failures so failed batches are not counted as accepted.
- Added accepted-sample status counting for non-empty batches that do not produce normalized records.
- Added optional raw batch NDJSON storage with per-context monthly files for replay/readout use cases.
- Added file-backed local status counter state under the configured data path.
- Added configurable HTTP body limits with a 500 MiB default for large HealthSave sync batches.
- Added unit and API integration tests.
- Added test strategy and test matrix documentation.
- Documented the upstream Health Data Hub reference project and required HealthSave iOS client.
