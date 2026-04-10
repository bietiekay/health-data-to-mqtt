# Agent Instructions

These instructions apply to all agents and maintainers working in this repository.

## Repository Purpose

This repository ports the original Health Data Hub server to a Node.js + TypeScript MQTT-first service.

The target service must remain compatible with HealthSave-compatible clients while replacing TimescaleDB-first persistence with MQTT publishing and lightweight local state.

## Hard Rules

- `reference-implementation/` is read-only reference material.
- Do not edit, format, rename, move, delete, or generate files inside `reference-implementation/`.
- All commits, documentation, code comments, review comments, and repository text must be written in English.
- Use current Node.js, current maintained frameworks, and established best practices at implementation time.
- Self-hosting must be supported through `Dockerfile` and `docker-compose.yml`.
- Tests must be added or updated with implementation changes.
- Preserve the HealthSave client-facing API contract unless `PORTING.md` records an explicit decision to change it.

## Commit Workflow

- `.specstory/` is managed by external tooling. Agents do not create or maintain SpecStory files manually.
- If `.specstory/` files are modified by the tooling, include those changes in commits when committing all current work.
- Always use the app version from `package.json` as the single source of truth for release/version labels in `CHANGELOG.md`.
- For every commit, compare the current app version with the newest release header in `CHANGELOG.md`.
- If the newest `CHANGELOG.md` version does not match the app version, create a new top release section with that app version before adding changes.
- Update `CHANGELOG.md` in the same commit following the app version.
- Write commit messages in English.

## Test Documentation Workflow

- Keep test planning documents in `TEST_STRATEGY.md` and `TEST_MATRIX.md`.
- Every change in tests must include a corresponding update in `TEST_MATRIX.md` in the same change.
- Manage, update, and treat `TEST_MATRIX.md` as the current inventory of existing, planned, and blocked tests.
- Run all tests.

## Collaboration Preference

- If the user writes a generic continuation message like "weiter machen", do not start implementing immediately.
- In that case, either wait for a concrete follow-up input or ask first whether direct implementation should start now.

## Documentation Roles

Use the documentation files this way:

| File | Role |
| --- | --- |
| `README.md` | User/operator documentation: purpose, usage, options, deployment |
| `PORTING.md` | Living engineering plan: compatibility, phases, open decisions |
| `AGENTS.md` | Agent and maintainer working rules |
| `TEST_STRATEGY.md` | Test approach and testing layers |
| `TEST_MATRIX.md` | Current test inventory |
| `CHANGELOG.md` | Versioned project changes using `package.json` version |
| `reference-implementation/` | Read-only behavior reference |

When implementation decisions change, update `PORTING.md`.

When user-visible behavior, configuration, deployment, or operation changes, update `README.md`.

When repository working rules change, update `AGENTS.md`.

## Reference Implementation Usage

The reference implementation may be read to understand:

- HTTP endpoint behavior,
- request and response shapes,
- API-key authentication,
- metric routing,
- field mappings,
- status counter names,
- persistence/upsert intent,
- Docker composition of the original stack.

The reference implementation must not be treated as editable source for the port. New code belongs outside `reference-implementation/`.

## Implementation Expectations

Prefer:

- Node.js active LTS at implementation time,
- TypeScript,
- Fastify or another current, maintained HTTP framework,
- structured validation for request and environment schemas,
- structured logging with sensitive-field redaction,
- explicit MQTT topic rendering,
- clear module boundaries for routes, ingest mapping, state, MQTT, and compatibility code,
- Docker-friendly defaults,
- tests close to the behavior they protect.

Avoid:

- ad hoc parsing when structured validation is practical,
- hidden global state that prevents reliable tests,
- changing client-facing API shapes casually,
- adding implementation code to documentation-only phases,
- broad refactors unrelated to the active task.

## Required Compatibility Surface

The target service must support:

- `GET /health`
- `GET /api/health`
- `POST /api/apple/batch`
- `GET /api/apple/status`

API-key behavior:

- empty or missing configured `API_KEY` means no API key is required,
- configured `API_KEY` requires matching `x-api-key`,
- invalid `x-api-key` returns `401`.

Status response keys:

- `heart_rate`
- `hrv`
- `blood_oxygen`
- `daily_activity`
- `sleep_sessions`
- `workouts`
- `quantity_samples`

## Testing Rules

Every implementation change should include relevant tests.

Expected coverage areas:

- health endpoints,
- auth behavior,
- batch request validation,
- empty batch behavior,
- metric mapper behavior,
- status counters,
- idempotency,
- MQTT topic rendering,
- MQTT publish behavior,
- replay fixtures for realistic client behavior.

If tests cannot be run, document why in the final response and keep the change scoped.

## Docker and Self-Hosting

The implementation must remain self-hostable.

Expected deliverables:

- `Dockerfile`,
- `docker-compose.yml`,
- `.env.example`,
- persistent state volume,
- MQTT broker example,
- optional TimescaleDB reference/validation service when needed.

Container runtime should use non-root users, health checks, and production-safe defaults.

## Change Hygiene

- Keep changes scoped to the requested task.
- Do not rewrite unrelated files.
- Do not modify generated or external reference files unless explicitly instructed and safe.
- Do not revert user changes unless explicitly asked.
- Prefer small, reviewable commits.
- Keep commit messages in English.
