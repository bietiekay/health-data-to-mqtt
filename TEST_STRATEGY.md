# Test Strategy

This document describes how the project should verify compatibility, MQTT behavior, and operational safety.

## Principles

- Tests move with implementation changes.
- Compatibility with the reference HTTP contract is the first test priority.
- Unit tests should cover deterministic parsing, mapping, and auth logic.
- Integration tests should exercise Fastify routes through in-process injection where possible.
- MQTT behavior should be covered with integration tests once the publisher exists.
- Replay fixtures should model realistic HealthSave sync batches.

## Test Layers

### Unit Tests

Unit tests cover small deterministic behavior:

- auth decisions,
- batch request defaults,
- metric-to-counter routing,
- future metric mappers,
- future topic rendering,
- future idempotency key generation.

### API Integration Tests

API integration tests cover the HealthSave-facing contract:

- `GET /health`,
- `GET /api/health`,
- `POST /api/apple/batch`,
- empty batch responses,
- status counters,
- optional API-key behavior.

### MQTT Integration Tests

MQTT integration tests are planned for the publisher implementation:

- raw event publication,
- normalized event publication,
- QoS and retain settings,
- topic template overrides,
- MQTT-disabled mode.

### Replay Tests

Replay tests are planned once metric normalization exists. Fixtures should include:

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
