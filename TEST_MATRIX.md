# Test Matrix

This file is the current inventory of existing, planned, and blocked tests. Update it in the same change whenever tests are added, removed, or changed.

| Area | Test | Status | Location | Notes |
| --- | --- | --- | --- | --- |
| Auth | No configured API key accepts missing header | Existing | `test/unit/auth.test.ts` | Reference-compatible auth disabled behavior |
| Auth | Configured API key accepts matching header | Existing | `test/unit/auth.test.ts` | Unit-level auth helper coverage |
| Auth | Configured API key rejects missing or wrong header | Existing | `test/unit/auth.test.ts` | Unit-level auth helper coverage |
| Config | Local YAML configuration file loads successfully | Existing | `test/unit/config.test.ts` | Covers local-only `--config` file format including MQTT topic templates |
| Config | Environment variables override YAML configuration | Existing | `test/unit/config.test.ts` | Preserves container-first env behavior |
| Config | Contexts load from environment JSON | Existing | `test/unit/config.test.ts` | Covers Docker-friendly multi-client context configuration |
| Ingest | Reference metrics map to status counters | Existing | `test/unit/ingest.test.ts` | Covers known initial routing table |
| Ingest | Unknown metrics map to `quantity_samples` | Existing | `test/unit/ingest.test.ts` | Reference-compatible fallback |
| Ingest | Batch schema applies reference-compatible defaults | Existing | `test/unit/ingest.test.ts` | Covers missing metric, batch fields, and samples |
| Ingest | JSON-encoded batch and sample wrappers deserialize | Existing | `test/unit/ingest.test.ts` | Covers wrapped `data` payloads and sample-level JSON strings |
| Ingest | Dedicated metrics normalize datapoints | Existing | `test/unit/ingest.test.ts` | Covers heart rate timestamp, value, and source extraction |
| Ingest | Generic quantity metrics normalize datapoints | Existing | `test/unit/ingest.test.ts` | Covers unknown metric fallback fields |
| Ingest | Activity summaries normalize aliases | Existing | `test/unit/ingest.test.ts` | Covers reference activity field aliases |
| Ingest | Sleep stage samples aggregate into sessions | Existing | `test/unit/ingest.test.ts` | Covers reference stage bucket and duration behavior |
| Ingest | Workouts normalize field variants | Existing | `test/unit/ingest.test.ts` | Covers start/end aliases and duration seconds conversion |
| Ingest | ISO timestamps normalize to UTC | Existing | `test/unit/ingest.test.ts` | Covers offset timestamp parsing |
| MQTT | Topic template rendering | Existing | `test/unit/ingest.test.ts` | Covers `{metric}` and `{context}` placeholders |
| MQTT | Raw event payload publication | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies one raw event per sample, topic, QoS, retain, metadata, and idempotency key shape |
| MQTT | Normalized event payload publication | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies logical topics, normalized metadata, payload shape, and idempotency key shape |
| MQTT | Current scalar value publication | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies logical current topics and value-only payloads |
| MQTT | Context-specific topic templates | Existing | `test/unit/mqtt-publisher.test.ts` | Verifies prefixed contexts can route to distinct topic templates |
| API | `GET /health` returns `{"status":"ok"}` | Existing | `test/integration/app.test.ts` | Uses Fastify injection |
| API | `GET /api/health` returns `{"status":"ok"}` | Existing | `test/integration/app.test.ts` | Uses Fastify injection |
| API | Batch happy path returns processed response | Existing | `test/integration/app.test.ts` | Counts accepted normalized datapoints |
| API | Empty batch returns reference-compatible empty response | Existing | `test/integration/app.test.ts` | No counter increment |
| API | Status endpoint returns known counter keys | Existing | `test/integration/app.test.ts` | Verifies HRV counter after ingest |
| API | Protected endpoints reject incorrect API keys | Existing | `test/integration/app.test.ts` | Verifies `401` and reference-compatible error body |
| API | Prefixed context endpoints isolate status counters | Existing | `test/integration/app.test.ts` | Verifies `/prefix/api/...` uses context routing and separate counts |
| MQTT | Batch route calls publisher | Existing | `test/integration/app.test.ts` | Verifies unknown metrics publish raw batches, extracted normalized datapoints, and current values before acceptance |
| MQTT | Publish failures reject batches | Existing | `test/integration/app.test.ts` | Verifies failed MQTT publication returns `502` without incrementing counters |
| MQTT | Broker-backed raw publication | Planned | Not implemented | Add a real broker or Testcontainers-style integration check |
| MQTT | Broker-backed normalized publication | Planned | Not implemented | Add a real broker or Testcontainers-style integration check |
| Replay | Realistic multi-metric sync fixtures | Planned | Not implemented | Add with mapper implementation |
| State | SQLite persistence | Planned | Not implemented | Current scaffold uses memory state only |
| State | Idempotency key generation and duplicate filtering | Planned | Not implemented | Add with persistent state layer |
