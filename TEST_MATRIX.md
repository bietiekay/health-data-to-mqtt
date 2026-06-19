# Test Matrix

This file is the current inventory of existing, planned, and blocked tests. Update it in the same change whenever tests are added, removed, or changed.

| Area | Test | Status | Location | Notes |
| --- | --- | --- | --- | --- |
| Auth | No configured API key accepts missing header | Existing | `test/unit/auth.test.ts` | Reference-compatible auth disabled behavior |
| Auth | Configured API key accepts matching header | Existing | `test/unit/auth.test.ts` | Unit-level auth helper coverage |
| Auth | Configured API key rejects missing or wrong header | Existing | `test/unit/auth.test.ts` | Unit-level auth helper coverage |
| Config | Local YAML configuration file loads successfully | Existing | `test/unit/config.test.ts` | Covers local-only `--config` file format including MQTT topic templates |
| Config | Environment variables override YAML configuration | Existing | `test/unit/config.test.ts` | Preserves container-first env behavior |
| Config | HTTP body limit loads from defaults, environment, and YAML | Existing | `test/unit/config.test.ts` | Covers the 500 MiB default and `HTTP_BODY_LIMIT_BYTES` override for large sync batches |
| Config | Contexts load from environment JSON | Existing | `test/unit/config.test.ts` | Covers Docker-friendly multi-client context configuration |
| Config | Data path loads from environment and YAML | Existing | `test/unit/config.test.ts` | Covers `DATA_PATH`, YAML `storage.dataPath`, and env override |
| Config | Raw storage path loads from environment and YAML | Existing | `test/unit/config.test.ts` | Covers opt-in `RAW_STORAGE_PATH`, YAML `storage.rawDataPath`, env override, and empty-path disabled behavior |
| Config | Whoop webhook secret loads from environment | Existing | `test/unit/config.test.ts` | Covers `WHOOP_WEBHOOK_SECRET` for HMAC verification |
| Ingest | Unknown metrics map to `quantity_samples` | Existing | `test/unit/ingest.test.ts` | Reference-compatible fallback for generic quantity metrics |
| Ingest | Batch schema applies reference-compatible defaults | Existing | `test/unit/ingest.test.ts` | Covers missing metric, batch fields, and samples |
| Ingest | JSON-encoded batch and sample wrappers deserialize | Existing | `test/unit/ingest.test.ts` | Covers wrapped `data` payloads and sample-level JSON strings |
| Ingest | Dedicated metrics normalize datapoints | Existing | `test/unit/ingest.test.ts` | Covers heart rate timestamp, value, and source extraction |
| Ingest | Blood oxygen aliases normalize datapoints | Existing | `test/unit/ingest.test.ts` | Covers HealthKit-style `oxygenSaturation` values and fractional saturation conversion |
| Ingest | Daily quantity metrics normalize into `daily_activity` | Existing | `test/unit/ingest.test.ts` | Covers `step_count` routing and date-level deduped records |
| Ingest | Daily quantity mapping matrix stays complete | Existing | `test/unit/ingest.test.ts` | Covers every supported `daily_activity` quantity metric and field transform |
| Ingest | Non-summary daily metrics remain in `quantity_samples` | Existing | `test/unit/ingest.test.ts` | Covers `apple_stand_time` fallback behavior |
| Ingest | Logged scalar quantity metrics are supported | Existing | `test/unit/ingest.test.ts` | Covers adopted `quantity_samples` metrics without unsupported-metric diagnostics |
| Ingest | Generic quantity metrics normalize datapoints | Existing | `test/unit/ingest.test.ts` | Covers unknown metric fallback fields |
| Ingest | Handwashing events normalize as quantity-like events | Existing | `test/unit/ingest.test.ts` | Covers `handwashing_event` timestamp/value/source handling plus numeric `rawValue` metadata |
| Ingest | Activity summaries normalize aliases | Existing | `test/unit/ingest.test.ts` | Covers reference activity field aliases |
| Ingest | Activity summary alias matrix stays complete | Existing | `test/unit/ingest.test.ts` | Covers all supported activity summary source fields and aliases |
| Ingest | Activity summary goal aliases are mapped | Existing | `test/unit/ingest.test.ts` | Covers `activeEnergyBurnedGoal`, `appleExerciseTimeGoal`, and `appleStandHoursGoal` normalization without unmapped diagnostics |
| Ingest | Sleep stage samples aggregate into sessions | Existing | `test/unit/ingest.test.ts` | Covers reference stage bucket and duration behavior |
| Ingest | Sleep sessions expose latest awake state | Existing | `test/unit/ingest.test.ts` | Covers normalized `awake` boolean from the latest sleep stage |
| Ingest | Workouts normalize field variants | Existing | `test/unit/ingest.test.ts` | Covers start/end aliases and duration seconds conversion |
| Ingest | Workout active energy normalizes from HealthSave aliases | Existing | `test/unit/ingest.test.ts` | Covers `workouts` calories from `activeEnergyBurned` plus sessionless active-energy fallback |
| Ingest | Blood pressure correlations preserve inner metric names | Existing | `test/unit/ingest.test.ts` | Covers subtype-specific `quantity_samples` identities |
| Ingest | Body temperature aliases normalize without public status entries | Existing | `test/unit/ingest.test.ts` | Covers `wrist_temperature` mapping to `body_temperature` |
| Ingest | Device identity honors source aliases and `HealthSave` fallback | Existing | `test/unit/ingest.test.ts` | Covers `sourceName`, `deviceName`, and fallback handling |
| Ingest | ISO timestamps normalize to UTC | Existing | `test/unit/ingest.test.ts` | Covers offset timestamp parsing |
| Ingest | Normalization stats separate rejected and in-batch deduped records | Existing | `test/unit/ingest.test.ts` | Covers receipt accounting without deriving rejection counts from accepted-record differences |
| Ingest | Sleep aggregation is not counted as in-batch dedupe | Existing | `test/unit/ingest.test.ts` | Covers honest accounting for folded sleep-stage samples |
| Ingest | ECG compatibility batches are accepted without rejected records | Existing | `test/unit/ingest.test.ts` | Verifies ECG payloads produce zero normalized records and zero validation rejections |
| Ingest | Category events can use fallback timestamps | Existing | `test/unit/ingest.test.ts` | Verifies generic quantity/category payloads can use `endDate` when `date` is absent |
| Ingest | Unknown health data diagnostics identify unmapped supported-metric fields | Existing | `test/unit/ingest.test.ts` | Verifies new sample fields on known metrics are reported with redacted field profiles, source identity field names, and candidate fields |
| Ingest | Unknown health data diagnostics identify unsupported metric candidates | Existing | `test/unit/ingest.test.ts` | Verifies new metric payloads expose unsupported metric, rejected sample, unmapped keys, candidate value fields, categorical previews, and no raw health/source values |
| MQTT | Topic template rendering | Existing | `test/unit/ingest.test.ts` | Covers `{metric}` and `{context}` placeholders |
| MQTT | Raw event payload publication | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies one raw event per sample, topic, QoS, retain, metadata, and idempotency key shape |
| MQTT | Normalized event payload publication | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies logical topics, normalized metadata, payload shape, and idempotency key shape |
| MQTT | Quantity sample topics preserve sample-level metric names | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies normalized and current topics use `metric_name` such as blood pressure subtypes |
| MQTT | Current scalar value publication | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies logical current topics and value-only payloads for dedicated and generic scalar metrics |
| MQTT | Multi-field current values fan out to field subtopics | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies `daily_activity`, `sleep_sessions`, and `workouts` publish per-field scalar topics |
| MQTT | Daily activity goal current values fan out to field subtopics | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies activity goal fields publish under `daily_activity/*_goal` current topics |
| MQTT | Sleep current value publication | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies `sleep_sessions` publishes latest awake state as `true` or `false` |
| MQTT | Context-specific topic templates | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies prefixed contexts can route to distinct topic templates |
| Storage | Raw batch archive writes NDJSON by context and month | Existing | `test/unit/raw-batch-storage.test.ts` | Verifies append-only lines, UTC month naming, and per-context directories |
| Storage | Raw batch archive encodes unusual context names | Existing | `test/unit/raw-batch-storage.test.ts` | Verifies context directory names do not allow path traversal |
| Storage | Raw batch archive preserves original request body | Existing | `test/unit/raw-batch-storage.test.ts` | Verifies wrapped payloads are stored unchanged instead of parsed replacements |
| State | SQLite-backed status store persists by context | Existing | `test/unit/state-store.test.ts` | Verifies prefixed contexts reload separate flat status objects from `status.sqlite` |
| State | SQLite-backed status store deduplicates and tracks oldest/newest | Existing | `test/unit/state-store.test.ts` | Verifies duplicate observations are ignored and ranges update |
| State | SQLite-backed status store writes the configured database | Existing | `test/unit/state-store.test.ts` | Verifies `DATA_PATH/status/status.sqlite` is created and new legacy ledgers are not appended |
| State | Legacy status NDJSON migration | Existing | `test/unit/state-store.test.ts` | Verifies legacy observations, quantity samples, device names containing colons, duplicate rows, malformed rows, migration logging, ledger renaming, and marker skip behavior |
| State | Idempotency index records and replays memory entries | Existing | `test/unit/idempotency-store.test.ts` | Verifies successful batch responses can be looked up by idempotency key |
| State | Idempotency index does not overwrite existing keys | Existing | `test/unit/idempotency-store.test.ts` | Verifies the first response remains authoritative for a reused key |
| State | File-backed idempotency index persists by context | Existing | `test/unit/idempotency-store.test.ts` | Verifies `<DATA_PATH>/idempotency/<context>/keys.ndjson` reload behavior |
| State | Sync receipt header parsing | Existing | `test/unit/sync-receipts.test.ts` | Verifies HealthSave receipt headers are extracted and timestamp-normalized |
| State | Sync receipt store ignores batches without sync run IDs | Existing | `test/unit/sync-receipts.test.ts` | Verifies v2 receipt proof only appears for real HealthSave sync runs |
| State | Sync receipt run, coverage, and idempotency summaries | Existing | `test/unit/sync-receipts.test.ts` | Verifies accepted-only accounting, metric coverage, and stored response replay metadata |
| State | Sync receipt summaries separate processed and failed rows | Existing | `test/unit/sync-receipts.test.ts` | Verifies `batches_processed` and `batches_failed` aggregation |
| State | File-backed sync receipt ledger persists by context | Existing | `test/unit/sync-receipts.test.ts` | Verifies `<DATA_PATH>/receipts/<context>/receipts.ndjson` reload behavior |
| State | Read store deterministic stream IDs and in-memory observations | Existing | `test/unit/read-store.test.ts` | Verifies stable UUIDs, canonical observation storage, identity pagination, device derivation, and export summaries |
| Readiness | Memory and file readiness probes | Existing | `test/unit/readiness.test.ts` | Verifies updated `status: "ready"` success shape, file-backed state probes, and unavailable state-store readiness |
| Readiness | Reference-compatible readiness ignores MQTT state | Existing | `test/unit/readiness.test.ts` | Verifies unavailable local state failures and DB/state-only V1 readiness semantics |
| API | `GET /health` returns `{"status":"ok"}` | Existing | `test/integration/app.test.ts` | Uses Fastify injection |
| API | `GET /api/health` returns `{"status":"ok"}` | Existing | `test/integration/app.test.ts` | Uses Fastify injection |
| API | `GET /ready` returns updated reference success when ready | Existing | `test/integration/app.test.ts` | Verifies unauthenticated `{status:"ready",database:"ok"}` success shape |
| API | File-backed state startup fails when local state is unavailable | Existing | `test/integration/app.test.ts` | Verifies unusable durable state fails startup instead of exposing partial status |
| API | Frozen reference V1 route inventory is served | Existing | `test/integration/app.test.ts` | Verifies health, readiness, Apple, metrics, and insights routes respond |
| API | Reference-shaped no-data insight and metrics responses | Existing | `test/integration/app.test.ts` | Verifies `/metrics` names and empty `/api/insights/*` response shapes |
| API | Insight query parameter validation | Existing | `test/integration/app.test.ts` | Verifies invalid `since`, `severity`, and `period` reference-style errors |
| API | `GET /api/v2/setup/diagnostics` is unauthenticated | Existing | `test/integration/app.test.ts` | Verifies port identity, auth-required flag, endpoint paths, and wrong-port hint |
| API | Markdown API reference auth inventory | Existing | `test/integration/app.test.ts` | Verifies all local contract-inventory endpoints classify as open, keyed, or HMAC |
| API | V2 meta and metric catalog endpoints | Existing | `test/integration/app.test.ts` | Verifies open `/api/v2/meta` and `/api/v2/metrics` response shapes, including adopted metric and activity goal catalog entries |
| API | Protected v2 sync endpoints enforce API key auth | Existing | `test/integration/app.test.ts` | Verifies v2 sync routes use the same optional `x-api-key` behavior as v1 protected routes |
| API | V2 sync receipts summarize batches with HealthSave run headers | Existing | `test/integration/app.test.ts` | Verifies latest run, run-specific receipt, coverage summary, receipt sample windows, destination counts, and accepted/rejected/deduped counts |
| API | Batches without sync run IDs do not appear in v2 receipts | Existing | `test/integration/app.test.ts` | Verifies latest returns an empty success, specific run lookup returns `404`, and coverage stays empty for v1-style requests |
| API | V2 read, identity, export, changes, and receipts from accepted batches | Existing | `test/integration/app.test.ts` | Verifies series, batch series, sources/devices/streams, readiness, export JSON/CSV, ETag 304, and receipt freshness from local read state |
| API | V2 unavailable engines return typed empty/no-op shapes | Existing | `test/integration/app.test.ts` | Verifies insights, sync anomalies, experiment candidates, and agent proposal stubs |
| API | V2 lightweight experiments | Existing | `test/integration/app.test.ts` | Verifies create/list/get/analyze/abandon local experiment records |
| API | V2 intelligence and privacy posture | Existing | `test/integration/app.test.ts` | Verifies settings updates redact secrets, consent, privacy, local detection, provider probe, and audit receipts |
| API | Batch body validation errors match reference style | Existing | `test/integration/app.test.ts` | Verifies invalid JSON `400` and schema validation `422` response shapes |
| API | Batch happy path returns processed delivery receipt | Existing | `test/integration/app.test.ts` | Counts valid deduplicated logical records and verifies reference delivery receipt fields |
| API | Non-empty batches without normalized records return `records: 0` and unchanged status | Existing | `test/integration/app.test.ts` | Verifies invalid samples are skipped without inflating status |
| API | Batch route logs structured unknown health data diagnostics | Existing | `test/integration/app.test.ts` | Verifies unmapped samples emit a redacted schema v2 JSON warning payload with implementation hints and no raw health/source values |
| API | Adopted logged sources do not emit unknown health diagnostics | Existing | `test/integration/app.test.ts` | Verifies supported logged metrics and activity goal fields process, update existing counters, and stay quiet in warning logs |
| API | Large batch payloads above Fastify default parser limit are accepted | Existing | `test/integration/app.test.ts` | Regression coverage for HealthSave sync batches larger than 1 MiB |
| API | Empty batch returns reference-compatible delivery receipt | Existing | `test/integration/app.test.ts` | Verifies empty receipt fields and no counter increment |
| API | Batch delivery receipts include sample-window headers | Existing | `test/integration/app.test.ts` | Verifies HealthSave sample-window headers are normalized and echoed |
| API | Batch delivery receipts derive sample windows from payload bounds | Existing | `test/integration/app.test.ts` | Verifies start/end payload fallback when window headers are absent |
| API | Malformed sample-window headers return null windows | Existing | `test/integration/app.test.ts` | Verifies malformed HealthSave timestamp headers do not fail batch ingest |
| API | Status endpoint returns flat metric objects | Existing | `test/integration/app.test.ts` | Verifies HRV status uses `{count, oldest, newest}` without wrapper keys |
| API | Duplicate retries do not inflate status and oldest/newest expand correctly | Existing | `test/integration/app.test.ts` | Verifies deduplicated logical-record status behavior |
| API | Status endpoint survives app restart | Existing | `test/integration/app.test.ts` | Verifies `DATA_PATH/status/status.sqlite` preserves already-observed status |
| API | Broken SQLite status store fails startup | Existing | `test/integration/app.test.ts` | Verifies startup fails instead of exposing partial status when the status database cannot open |
| API | Protected endpoints reject incorrect API keys | Existing | `test/integration/app.test.ts` | Verifies `401` and reference-compatible error body |
| API | Prefixed context endpoints isolate status objects | Existing | `test/integration/app.test.ts` | Verifies `/prefix/api/...` uses context routing and separate status rows |
| API | Prefixed context endpoints isolate v2 diagnostics and receipts | Existing | `test/integration/app.test.ts` | Verifies prefixed v2 endpoint paths and context-specific sync run storage |
| API | Blood pressure correlations count as distinct quantity samples | Existing | `test/integration/app.test.ts` | Verifies systolic and diastolic rows do not collapse into one record |
| API | Body temperature batches do not surface in public status | Existing | `test/integration/app.test.ts` | Verifies processed body temperature stays outside the public status keys |
| MQTT | Batch route calls publisher | Existing | `test/integration/app.test.ts` | Verifies unknown metrics publish raw batches, extracted normalized datapoints, and current values before acceptance |
| MQTT | Batch route publishes daily quantity data as `daily_activity` | Existing | `test/integration/app.test.ts` | Verifies `step_count` publishes normalized `daily_activity` records before acceptance |
| MQTT | Batch route publishes real daily activity MQTT topics end-to-end | Existing | `test/integration/app.test.ts` | Verifies wrapped step payloads emit real raw, normalized, and field-specific current topics |
| MQTT | Batch route publishes workout active energy as normalized and current data | Existing | `test/integration/app.test.ts` | Verifies `workouts` `activeEnergy` payloads produce normalized records, current values, and workout status observations |
| MQTT | Batch route publishes sleep awake state as normalized and current data | Existing | `test/integration/app.test.ts` | Verifies sleep stage payloads produce normalized `awake`, current values, and sleep status observations |
| MQTT | Batch route publishes blood oxygen aliases as normalized and current data | Existing | `test/integration/app.test.ts` | Verifies `blood_oxygen` `oxygenSaturation` payloads produce normalized records, current values, and blood oxygen status observations |
| MQTT | Batch route publishes correlated quantity samples to per-sample topics | Existing | `test/integration/app.test.ts` | Verifies blood pressure subtype exports use preserved sample metric topics end-to-end |
| MQTT | Publish failures reject batches | Existing | `test/integration/app.test.ts` | Verifies failed MQTT publication returns `502` without status observation updates |
| Storage | Batch route archives non-empty valid batches | Existing | `test/integration/app.test.ts` | Verifies the raw request body is stored before successful acceptance |
| Storage | Batch route preserves wrapped request bodies while exporting MQTT | Existing | `test/integration/app.test.ts` | Verifies the original wrapped request is archived alongside real MQTT exports |
| Storage | Batch route skips empty batch archive writes | Existing | `test/integration/app.test.ts` | Verifies empty batches do not create raw archive files |
| Storage | Batch route rejects storage failures before side effects | Existing | `test/integration/app.test.ts` | Verifies storage failure returns `500` without MQTT publish or status observation updates |
| Storage | Prefixed contexts write to isolated archive directories | Existing | `test/integration/app.test.ts` | Verifies context-specific raw archive layout |
| State | Idempotency key replay avoids repeated ingest side effects | Existing | `test/integration/app.test.ts` | Verifies matching `Idempotency-Key` and payload hash replays the original response without MQTT/status duplication |
| State | Idempotency key conflict rejects before ingest side effects | Existing | `test/integration/app.test.ts` | Verifies reused keys with different payload hashes return `409` without MQTT/status duplication |
| State | Idempotency key replay works without sync run IDs | Existing | `test/integration/app.test.ts` | Verifies idempotency is decoupled from v2 delivery receipts |
| State | Batch ID fallback idempotency replays accepted batches | Existing | `test/integration/app.test.ts` | Verifies `X-HealthSave-Batch-ID` is used when explicit `Idempotency-Key` is absent |
| State | Sync-run fallback idempotency replays accepted batches | Existing | `test/integration/app.test.ts` | Verifies `sync_run_id:metric:batch_index` fallback when explicit key and batch ID are absent |
| State | File-backed idempotency survives app restart | Existing | `test/integration/app.test.ts` | Verifies replay works after restarting with the same `DATA_PATH` |
| State | Failed sync-run batches appear in receipt summaries | Existing | `test/integration/app.test.ts` | Verifies MQTT failure records `batches_failed` and retry can later succeed |
| Webhooks | Whoop webhook HMAC helper | Existing | `test/unit/whoop.test.ts` | Verifies base64 HMAC-SHA256 over timestamp plus body and rejects tampered/missing inputs |
| Webhooks | Whoop webhook route signature enforcement | Existing | `test/integration/app.test.ts` | Verifies configured `WHOOP_WEBHOOK_SECRET` requires valid Whoop timestamp and signature headers |
| MQTT | Broker-backed raw publication | Planned | Not implemented | Add a real broker or Testcontainers-style integration check |
| MQTT | Broker-backed normalized publication | Planned | Not implemented | Add a real broker or Testcontainers-style integration check |
| Replay | Realistic multi-metric sync fixtures | Planned | Not implemented | Add with mapper implementation |
| State | Broader deterministic record idempotency | Planned | Not implemented | Retry-key replay exists; deterministic record-key filtering beyond status counters remains future work |
