# Test Strategy

This document describes how the project should verify compatibility, MQTT behavior, and operational safety.

## Principles

- Tests move with implementation changes.
- Compatibility with the reference HTTP contract is the first test priority.
- Unit tests should cover deterministic parsing, mapping, and auth logic.
- Integration tests should exercise Fastify routes through in-process injection where possible.
- MQTT behavior should be covered with unit tests for payload construction and integration tests for route-to-publisher behavior.
- Multi-client context behavior should verify prefixed routes, topic selection, and isolated status counters.
- Replay fixtures should model realistic HealthSave sync batches.

## Test Layers

### Unit Tests

Unit tests cover small deterministic behavior:

- auth decisions,
- batch request defaults,
- metric-to-counter routing,
- future metric mappers,
- topic rendering,
- raw MQTT payload construction,
- raw batch archive path handling,
- idempotency key generation.

### API Integration Tests

API integration tests cover the HealthSave-facing contract:

- `GET /health`,
- `GET /api/health`,
- `POST /api/apple/batch`,
- empty batch responses,
- status counters,
- optional API-key behavior.
- prefixed context endpoints.
- raw batch archive success, skip, and failure behavior.

### MQTT Tests

MQTT tests cover implemented publisher behavior and planned broker-backed integration coverage:

- raw event publication through a recording client,
- normalized event publication through a recording client,
- scalar current value publication through a recording client,
- API route calls into the publisher before accepting non-empty batches,
- QoS and retain settings,
- topic template overrides,
- context-specific topic template overrides,
- MQTT-disabled mode,
- future broker-backed publication checks,
- future broker-backed normalized publication checks.

### Replay Tests

Replay tests are planned once realistic client fixtures are captured. Fixtures should include:

- multiple metric types,
- duplicate samples,
- out-of-order batches,
- unknown metrics,
- mixed timestamp fields,
- older client field variants.

## Running Tests

Run the full test suite:

```bash
npm test
```

Run TypeScript checks:

```bash
npm run typecheck
```

Build the app:

```bash
npm run build
```
