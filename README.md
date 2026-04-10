# Health Data to MQTT

Health Data to MQTT is a drop-in server for the [HealthSave iOS app](https://apps.apple.com/app/id6759843047). It accepts HealthKit-derived sync batches through the same HTTP API as the original [Health Data Hub](https://github.com/umutkeltek/health-data-hub/tree/main) server and is being ported toward an MQTT-first data pipeline instead of making TimescaleDB and Grafana the primary destination.

The repository currently contains a Node.js + TypeScript Fastify server with compatibility endpoints, optional API-key authentication, raw and normalized MQTT publishing, durable local status counters, optional raw batch storage, Docker support, and tests. Replay fixtures and persistent idempotency are still planned implementation phases.

![Health Data to MQTT screenshot](./screenshot.png)

## Why This Exists

[HealthSave](https://apps.apple.com/app/id6759843047) can already send Apple Health data to a self-hosted server. The original [Health Data Hub](https://github.com/umutkeltek/health-data-hub/tree/main) project stores that data in TimescaleDB and visualizes it with Grafana. This project keeps the same client-facing sync contract but changes the integration model:

- Health data becomes available through MQTT topics.
- Home automation systems can subscribe in near real time.
- Storage, dashboards, alerts, and automations can be chosen independently.
- The existing iOS app can keep syncing without client changes.
- A reference-compatible migration path remains possible during the port.

## Current Status

This repository contains the compatibility server, durable status counters, and initial raw plus normalized MQTT pipeline, not the final idempotent pipeline.

Available now:

- `README.md` - user-facing project documentation.
- `PORTING.md` - living porting plan and implementation discussion document.
- `AGENTS.md` - working instructions for coding agents and maintainers.
- `TEST_STRATEGY.md` and `TEST_MATRIX.md` - test planning and test inventory.
- `src/` - Fastify compatibility server, reference-compatible datapoint extraction, MQTT publishers, and optional raw batch storage.
- `test/` - unit, API integration, and publisher behavior tests.
- `Dockerfile` and `docker-compose.yml` - initial self-hosting setup.
- `reference-implementation/` - read-only reference copy of the original FastAPI + TimescaleDB implementation.

The `reference-implementation/` directory is included only to document existing behavior. Do not edit it as part of this port.

## Upstream Reference and Required Client

This project is a porting effort based on the original [Health Data Hub](https://github.com/umutkeltek/health-data-hub/tree/main) project.

The required client app is [HealthSave](https://apps.apple.com/app/id6759843047) for iOS. HealthSave acts as the HealthKit bridge and sends sync batches to the configured server URL.

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

Run locally with a configuration file:

```bash
cp config/app.config.example.yaml config/app.config.local.yaml
npm run build
npm run start:local
```

The configuration file path is only intended for plain local `npm start` runs. Docker and Docker Compose deployments should use environment variables through `.env` instead.

Local development config quick guide:

1. Copy `config/app.config.example.yaml` to `config/app.config.local.yaml`.
2. Edit `config/app.config.local.yaml` for your machine, for example local port, API key, MQTT broker URL, or log level.
3. Build the TypeScript output with `npm run build`.
4. Start the server with `npm run start:local`.
5. Point HealthSave at `http://your-machine-ip:8000` or the port configured in your local YAML file.

`config/app.config.local.yaml` is ignored by Git, so it is safe to keep local secrets or machine-specific values there. Environment variables still override local YAML values when both are set.

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

## Multiple Client Contexts

The root URL continues to work as the `default` context:

```text
http://your-server:8000
```

Additional clients can use configured prefixes as their HealthSave server URL:

```text
http://your-server:8000/daniel
http://your-server:8000/alice
```

HealthSave still appends the same API paths, so a client configured with `/daniel` sends batches to:

```text
/daniel/api/apple/batch
```

Each context has its own MQTT topic templates and status counters. This allows one self-hosted server to receive multiple clients while keeping MQTT output and `/api/apple/status` counts separated by context.

Context topic templates support:

| Placeholder | Value |
| --- | --- |
| `{metric}` | Normalized metric name or incoming generic metric name |
| `{context}` | Context name such as `default`, `daniel`, or `alice` |

## MQTT Output

The service publishes one raw MQTT event for each source sample, one normalized MQTT event for each accepted datapoint, and a scalar current value for datapoints that have a single primary value. Normalization follows the reference implementation's field extraction rules for dedicated metrics, generic quantities, activity summaries, sleep sessions, and workouts.

When MQTT is enabled, non-empty batch requests are only accepted after MQTT publishing succeeds. If publishing fails, the endpoint returns `502` so the client can retry instead of silently dropping data.

Default topics:

| Topic | Purpose |
| --- | --- |
| `healthsave/raw/{metric}` | Original batch sample with ingestion metadata |
| `healthsave/normalized/{metric}` | Extracted datapoint with stable metric-specific fields |
| `healthsave/current/{metric}` | Latest scalar value for metrics with one primary value |
| `healthsave/status/sync` | Planned sync/status event |

Example raw topic:

```text
healthsave/raw/heart_rate
```

Raw payload shape:

```json
{
  "metric": "heart_rate",
  "event_type": "raw_sample",
  "ingested_at": "2026-04-10T12:00:00.000Z",
  "batch_index": 0,
  "total_batches": 1,
  "device_id": "Apple Watch",
  "sample_index": 0,
  "sample": {
    "date": "2026-04-10T11:58:00.000Z",
    "qty": 72,
    "source": "Apple Watch"
  },
  "idempotency_key": "..."
}
```

Example normalized topic:

```text
healthsave/normalized/heart_rate
```

Normalized payload shape:

```json
{
  "metric": "heart_rate",
  "normalized_metric": "heart_rate",
  "event_type": "normalized_sample",
  "ingested_at": "2026-04-10T12:00:00.000Z",
  "batch_index": 0,
  "total_batches": 1,
  "device_id": "Apple Watch",
  "record_index": 0,
  "normalized_sample": {
    "time": "2026-04-10T11:58:00.000Z",
    "bpm": 72,
    "source_id": "Apple Watch"
  },
  "idempotency_key": "..."
}
```

Timestamp fields are parsed from ISO 8601 input and published as UTC ISO strings. Date-only activity summaries are published as `YYYY-MM-DD`.

Example current topic:

```text
healthsave/current/heart_rate
```

Current payload:

```text
72
```

Current messages use the same metric names as normalized topics, but the payload is only the scalar value. Current values are emitted for dedicated metrics and generic quantity samples, such as `heart_rate`, `hrv`, `blood_oxygen`, `body_temperature`, `step_count`, or `walking_speed`. Multi-field records such as activity summaries, sleep sessions, and workouts stay on normalized topics until a specific scalar topic mapping is added.

Set `LOG_LEVEL=debug` while capturing new client payload shapes. Batch debug logs include top-level request field names, metric name, batch counters, record count, status counter bucket, the first sample's field names, and MQTT publish counts without logging complete health samples by default. Set `LOG_LEVEL=trace` only when you intentionally need raw request bodies in the logs.

Exact normalized payload fields may still change while the porting plan is finalized. Compatibility requirements and open decisions are tracked in `PORTING.md`.

## Local State

Status counters for `/api/apple/status` are stored in the configured data path when `STATE_BACKEND=file`.

Docker example:

```env
DATA_PATH=/data
STATE_BACKEND=file
```

The state file is written to:

```text
<DATA_PATH>/state.json
```

Docker Compose mounts `/data` as a persistent volume, so the HealthSave app can see records that were already accepted by the server after container restarts. Set `STATE_BACKEND=memory` only for disposable local runs or tests.

## Raw Batch Storage

Set `RAW_STORAGE_PATH` to archive non-empty, valid HealthSave batch requests before MQTT publishing. Leave it empty to disable raw storage.

Docker example:

```env
RAW_STORAGE_PATH=/data/raw
```

The Docker Compose service already mounts persistent storage at `/data`, so `/data/raw` persists across container restarts.

Stored files contain raw health payloads. Treat the directory as sensitive personal health data and protect it with filesystem permissions, backups, and host-level encryption appropriate for your deployment.

The archive is organized by context and server ingestion month:

```text
<RAW_STORAGE_PATH>/<context>/yyyy-mm
```

Example:

```text
/data/raw/default/2026-04
/data/raw/daniel/2026-04
```

Files are newline-delimited JSON. Each line is one accepted batch request as Fastify parsed it, with minimal replay metadata:

```json
{"ingested_at":"2026-04-10T12:00:00.000Z","context":"default","metric":"heart_rate","batch_index":0,"total_batches":1,"body":{"metric":"heart_rate","batch_index":0,"total_batches":1,"samples":[{"date":"2026-04-10T12:00:00Z","qty":72}]}}
```

Empty batches are intentionally skipped. If raw storage is enabled and the archive write fails, the batch is rejected before MQTT publishing and status counters are updated so the client can retry.

## Configuration Options

The service can be configured in two ways:

- Environment variables: preferred and required for Docker/Docker Compose.
- Local YAML config file: optional for plain local `npm start` runs only.

For Docker:

```bash
cp .env.default .env
docker compose up --build
```

For local npm:

```bash
cp config/app.config.example.yaml config/app.config.local.yaml
npm run build
npm run start:local
```

Environment variables override values from the local YAML config file when both are present.

Core options:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `PORT` | `8000` | HTTP port |
| `HTTP_BODY_LIMIT_BYTES` | `524288000` | Maximum accepted request body size. Defaults to 500 MiB for large HealthSave sync batches. |
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
| `MQTT_TOPIC_CURRENT` | `healthsave/current/{metric}` | Scalar current value topic template |
| `CONTEXTS` | empty | Optional JSON array of prefixed client contexts |

State and migration options:

| Variable | Default | Description |
| --- | --- | --- |
| `DATA_PATH` | `/data` | Persistent application data directory |
| `STATE_BACKEND` | `file` | Local status counter backend. Use `file` for durable counters or `memory` for disposable runs. |
| `IDEMPOTENCY_ENABLED` | `true` | Avoid duplicate processing where possible |
| `IDEMPOTENCY_WINDOW_DAYS` | `30` | Retention window for idempotency keys |
| `TIMESCALE_MODE` | `off` | Optional reference mode: `off`, `shadow`, or `bridge` |
| `TIMESCALE_URL` | empty | Optional Timescale/PostgreSQL connection string |
| `TIMESCALE_STRICT_STARTUP` | `false` | Fail startup if reference mode cannot connect |
| `RAW_STORAGE_PATH` | empty | Optional raw NDJSON batch archive path. Empty disables raw storage. |

### Local Config File

The commented template lives at:

```text
config/app.config.example.yaml
```

Copy it before editing:

```bash
cp config/app.config.example.yaml config/app.config.local.yaml
```

Pass it to the local server:

```bash
npm run start:local
```

The local config file uses grouped YAML sections for `http`, `auth`, `logging`, `mqtt`, `contexts`, and `state`. `config/app.config.local.yaml` is ignored by Git so local secrets and machine-specific settings are not committed. It is not used by the Docker image or `docker-compose.yml`; container deployments should use `.env` variables.

Example local adjustments:

```yaml
http:
  host: "0.0.0.0"
  port: 8000

auth:
  apiKey: "dev-secret"

mqtt:
  url: "mqtt://localhost:1883"
  topics:
    raw: "healthsave/{context}/raw/{metric}"
    normalized: "healthsave/{context}/normalized/{metric}"
    current: "healthsave/{context}/current/{metric}"

contexts:
  - name: "daniel"
    prefix: "/daniel"
    topics:
      raw: "healthsave/daniel/raw/{metric}"
      normalized: "healthsave/daniel/normalized/{metric}"
      current: "healthsave/daniel/current/{metric}"

logging:
  level: "debug"

state:
  backend: "file"

storage:
  dataPath: ".data"
  rawDataPath: ".data/raw"
```

Then start with:

```bash
npm run build
npm run start:local
```

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
