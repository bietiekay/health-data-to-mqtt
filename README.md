# Health Data to MQTT

Health Data to MQTT is a drop-in server for the HealthSave iOS app. It accepts HealthKit-derived sync batches through the same HTTP API as the original Health Data Hub server and is being ported toward an MQTT-first data pipeline instead of making TimescaleDB and Grafana the primary destination.

The repository currently contains the initial Node.js + TypeScript server scaffold with Fastify, compatibility endpoints, optional API-key authentication, Docker support, and tests. MQTT publishing and full metric normalization are still planned implementation phases.

## Why This Exists

HealthSave can already send Apple Health data to a self-hosted server. The original server stores that data in TimescaleDB and visualizes it with Grafana. This project keeps the same client-facing sync contract but changes the integration model:

- Health data becomes available through MQTT topics.
- Home automation systems can subscribe in near real time.
- Storage, dashboards, alerts, and automations can be chosen independently.
- The existing iOS app can keep syncing without client changes.
- A reference-compatible migration path remains possible during the port.

## Current Status

This repository contains the first implementation scaffold, not the final MQTT pipeline.

Available now:

- `README.md` - user-facing project documentation.
- `PORTING.md` - living porting plan and implementation discussion document.
- `AGENTS.md` - working instructions for coding agents and maintainers.
- `TEST_STRATEGY.md` and `TEST_MATRIX.md` - test planning and test inventory.
- `src/` - initial Fastify compatibility server.
- `test/` - unit and API integration tests.
- `Dockerfile` and `docker-compose.yml` - initial self-hosting setup.
- `reference-implementation/` - read-only reference copy of the original FastAPI + TimescaleDB implementation.

The `reference-implementation/` directory is included only to document existing behavior. Do not edit it as part of this port.

## Intended Usage

Run the development server:

```bash
npm install
npm run dev
```

Run tests:

```bash
npm test
```

Build and start:

```bash
npm run build
npm start
```

Run with Docker Compose:

```bash
cp .env.default .env
docker compose up --build
```

Use the service as the HealthSave server endpoint:

```text
http://your-server-ip:8000
```

HealthSave app flow:

1. Open HealthSave on iOS.
2. Go to Settings -> Server Sync.
3. Set the server URL to your deployed Health Data to MQTT instance.
4. Optionally enter the configured API key.
5. Run "Sync New Data".

The app appends the API paths itself, so users should configure only the base URL.

## What It Will Receive

The server is designed to receive the same HealthSave batch payloads as the reference implementation:

- heart rate
- heart rate variability
- blood oxygen
- body temperature
- activity summaries
- sleep analysis
- workouts
- any other HealthKit quantity metric through a generic fallback

Supported client-facing endpoints:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Basic service health check |
| `/api/health` | GET | App-compatible health check |
| `/api/apple/batch` | POST | Receive one metric batch |
| `/api/apple/status` | GET | Return sync/status counters |

## MQTT Output

The service is planned to publish both raw and normalized events.

Default topics:

| Topic | Purpose |
| --- | --- |
| `healthsave/raw/{metric}` | Original batch sample with ingestion metadata |
| `healthsave/normalized/{metric}` | Metric-specific normalized sample |
| `healthsave/status/sync` | Optional sync/status event |

Example normalized topic:

```text
healthsave/normalized/heart_rate
```

Expected payload shape:

```json
{
  "metric": "heart_rate",
  "ingested_at": "2026-04-10T12:00:00.000Z",
  "batch_index": 0,
  "total_batches": 1,
  "device_id": "apple_watch",
  "normalized_sample": {
    "time": "2026-04-10T11:58:00.000Z",
    "bpm": 72,
    "source_id": "Apple Watch"
  },
  "idempotency_key": "..."
}
```

Exact payload fields may still change while the porting plan is finalized. Compatibility requirements and open decisions are tracked in `PORTING.md`.

## Configuration Options

The planned service will be configured through environment variables.

Core options:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `PORT` | `8000` | HTTP port |
| `API_KEY` | empty | Optional API key. Empty disables auth enforcement. |
| `LOG_ENABLED` | `true` | Enables structured logs by default |
| `LOG_LEVEL` | `info` | Log verbosity |

MQTT options:

| Variable | Default | Description |
| --- | --- | --- |
| `MQTT_ENABLED` | `true` | Enable MQTT publishing |
| `MQTT_URL` | `mqtt://broker:1883` | Broker URL |
| `MQTT_CLIENT_ID` | `healthsave-proxy` | MQTT client identifier |
| `MQTT_USERNAME` | empty | Optional broker username |
| `MQTT_PASSWORD` | empty | Optional broker password |
| `MQTT_QOS` | `1` | Publish QoS |
| `MQTT_RETAIN` | `false` | Retain published messages |
| `MQTT_TOPIC_RAW` | `healthsave/raw/{metric}` | Raw event topic template |
| `MQTT_TOPIC_NORMALIZED` | `healthsave/normalized/{metric}` | Normalized event topic template |

State and migration options:

| Variable | Default | Description |
| --- | --- | --- |
| `STATE_BACKEND` | `sqlite` | Local state backend, planned values: `sqlite` or `redis` |
| `SQLITE_PATH` | `/data/state.db` | SQLite state file path |
| `IDEMPOTENCY_ENABLED` | `true` | Avoid duplicate processing where possible |
| `IDEMPOTENCY_WINDOW_DAYS` | `30` | Retention window for idempotency keys |
| `TIMESCALE_MODE` | `off` | Optional reference mode: `off`, `shadow`, or `bridge` |
| `TIMESCALE_URL` | empty | Optional Timescale/PostgreSQL connection string |
| `TIMESCALE_STRICT_STARTUP` | `false` | Fail startup if reference mode cannot connect |

## Deployment Model

The intended deployment is a containerized service next to an MQTT broker.

Typical services:

- `proxy-api` - this Node.js server
- `mqtt-broker` - for example Eclipse Mosquitto
- optional `timescaledb` - only during validation or bridge/shadow migration

Production deployments should place HTTPS and network-level access control in front of the API, especially when syncing from outside the local network.

## Reference Implementation

The original implementation is stored in `reference-implementation/`.

It provides the behavior this project must preserve at the HTTP/API boundary:

- FastAPI service on port `8000`
- optional `x-api-key` authentication
- TimescaleDB persistence
- Grafana-oriented schema and dashboards
- metric mapping and fallback behavior

Use it for comparison, tests, and behavioral clarification only. It is not the implementation target and should not be modified during this port.

## Porting Plan

See `PORTING.md` for the active engineering plan, compatibility notes, rollout phases, open questions, and implementation checklist.
