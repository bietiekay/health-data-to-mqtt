# Test Matrix

This file is the current inventory of existing, planned, and blocked tests. Update it in the same change whenever tests are added, removed, or changed.

| Area | Test | Status | Location | Notes |
| --- | --- | --- | --- | --- |
| Auth | No configured API key accepts missing header | Existing | `test/unit/auth.test.ts` | Reference-compatible auth disabled behavior |
| Auth | Configured API key accepts matching header | Existing | `test/unit/auth.test.ts` | Unit-level auth helper coverage |
| Auth | Configured API key rejects missing or wrong header | Existing | `test/unit/auth.test.ts` | Unit-level auth helper coverage |
| Config | Local YAML configuration file loads successfully | Existing | `test/unit/config.test.ts` | Covers local-only `--config` file format |
| Config | Environment variables override YAML configuration | Existing | `test/unit/config.test.ts` | Preserves container-first env behavior |
| Ingest | Reference metrics map to status counters | Existing | `test/unit/ingest.test.ts` | Covers known initial routing table |
| Ingest | Unknown metrics map to `quantity_samples` | Existing | `test/unit/ingest.test.ts` | Reference-compatible fallback |
| Ingest | Batch schema applies reference-compatible defaults | Existing | `test/unit/ingest.test.ts` | Covers missing metric, batch fields, and samples |
| MQTT | Topic template rendering | Existing | `test/unit/ingest.test.ts` | Initial `{metric}` placeholder rendering helper |
| API | `GET /health` returns `{"status":"ok"}` | Existing | `test/integration/app.test.ts` | Uses Fastify injection |
| API | `GET /api/health` returns `{"status":"ok"}` | Existing | `test/integration/app.test.ts` | Uses Fastify injection |
| API | Batch happy path returns processed response | Existing | `test/integration/app.test.ts` | Counts raw sample length in scaffold |
| API | Empty batch returns reference-compatible empty response | Existing | `test/integration/app.test.ts` | No counter increment |
| API | Status endpoint returns known counter keys | Existing | `test/integration/app.test.ts` | Verifies HRV counter after ingest |
| API | Protected endpoints reject incorrect API keys | Existing | `test/integration/app.test.ts` | Verifies `401` and reference-compatible error body |
| MQTT | Raw event publication | Planned | Not implemented | Add when MQTT publisher is implemented |
| MQTT | Normalized event publication | Planned | Not implemented | Add when metric mappers are implemented |
| Replay | Realistic multi-metric sync fixtures | Planned | Not implemented | Add with mapper implementation |
| State | SQLite persistence | Planned | Not implemented | Current scaffold uses memory state only |
| State | Idempotency key generation and duplicate filtering | Planned | Not implemented | Add with persistent state layer |
