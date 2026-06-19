import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { apiReferenceEndpoints } from "../../src/contracts/api-reference.js";
import { loadConfig, type AppContextConfig } from "../../src/config.js";
import type { BatchRequest, NormalizedRecord } from "../../src/ingest.js";
import type {
  CurrentPublishResult,
  HealthMqttPublisher,
  NormalizedPublishResult,
  RawPublishResult,
} from "../../src/mqtt/publisher.js";
import {
  createMqttPublisherFromClient,
  type MqttPublishClient,
} from "../../src/mqtt/publisher.js";
import { createMemorySyncReceiptStore } from "../../src/state/sync-receipts.js";
import type { RawBatchStorage } from "../../src/storage/raw-batch-storage.js";
import { createWhoopSignature } from "../../src/webhooks/whoop.js";

const baseConfig = loadConfig({
  HOST: "127.0.0.1",
  PORT: "0",
  LOG_ENABLED: "false",
  API_KEY: "",
  STATE_BACKEND: "memory",
});

let app: FastifyInstance | undefined;
let tempDirectory: string | undefined;

interface PublishCall {
  topic: string;
  message: string | Buffer;
  options?: { qos?: 0 | 1 | 2; retain?: boolean };
}

async function createApp(apiKey = "", overrides: Partial<typeof baseConfig> = {}) {
  app = await buildApp({
    config: {
      ...baseConfig,
      ...overrides,
      apiKey,
      logEnabled: false,
      mqtt: {
        ...baseConfig.mqtt,
        ...overrides.mqtt,
        enabled: false,
      },
    },
  });

  return app;
}

function createRecordingMqttPublisher(): HealthMqttPublisher & {
  batches: Array<{
    context: AppContextConfig;
    batch: BatchRequest;
  }>;
  normalizedBatches: Array<{
    context: AppContextConfig;
    batch: BatchRequest;
    records: NormalizedRecord[];
  }>;
  currentBatches: Array<{
    context: AppContextConfig;
    records: NormalizedRecord[];
  }>;
} {
  return {
    batches: [],
    normalizedBatches: [],
    currentBatches: [],
    async publishRawBatch(context, batch): Promise<RawPublishResult> {
      this.batches.push({ context, batch });
      return {
        topic: `${context.name}/raw/${batch.metric}`,
        records: batch.samples.length,
      };
    },
    async publishNormalizedBatch(
      context,
      batch,
      records,
    ): Promise<NormalizedPublishResult> {
      this.normalizedBatches.push({ context, batch, records });
      return {
        records: records.length,
        topics: records.map(
          (record) => `${context.name}/normalized/${record.normalizedMetric}`,
        ),
      };
    },
    async publishCurrentBatch(context, records): Promise<CurrentPublishResult> {
      this.currentBatches.push({ context, records });
      return {
        records: records.length,
        topics: records.map(
          (record) => `${context.name}/current/${record.normalizedMetric}`,
        ),
      };
    },
    isReady() {
      return true;
    },
    async close() {
      return undefined;
    },
  };
}

function createRecordingPublishClient(): MqttPublishClient & {
  publishCalls: PublishCall[];
  closed: boolean;
} {
  return {
    publishCalls: [],
    closed: false,
    async publishAsync(topic, message, options) {
      this.publishCalls.push({ topic, message, options });
      return undefined;
    },
    async endAsync() {
      this.closed = true;
    },
  };
}

function createRecordingLogStream(): {
  lines: string[];
  write(chunk: string): void;
} {
  return {
    lines: [],
    write(chunk) {
      this.lines.push(chunk);
    },
  };
}

function emptyMetricStatus() {
  return {
    count: 0,
    oldest: null,
    newest: null,
  };
}

function emptyStatusResponse() {
  return {
    heart_rate: emptyMetricStatus(),
    hrv: emptyMetricStatus(),
    blood_oxygen: emptyMetricStatus(),
    daily_activity: emptyMetricStatus(),
    sleep_sessions: emptyMetricStatus(),
    workouts: emptyMetricStatus(),
    quantity_samples: emptyMetricStatus(),
  };
}

function metricStatus(
  count: number,
  oldest: string,
  newest = oldest,
) {
  return {
    count,
    oldest,
    newest,
  };
}

function expectDeliveryReceipt(
  body: unknown,
  expected: {
    status: "processed" | "empty";
    metric: string;
    batch: number;
    total_batches: number;
    records: number;
    records_received: number;
    records_rejected?: number;
    records_deduped_in_batch?: number | null;
    receipt_id?: string;
    sync_run_id?: string | null;
    batch_id?: string | null;
    idempotency_key?: string | null;
    sample_window?: {
      min_sample_time: string | null;
      max_sample_time: string | null;
    };
  },
) {
  const recordsDedupedInBatch =
    "records_deduped_in_batch" in expected
      ? expected.records_deduped_in_batch
      : 0;
  const sampleWindow = expected.sample_window ?? {
    min_sample_time: null,
    max_sample_time: null,
  };
  expect(body).toMatchObject({
    status: expected.status,
    metric: expected.metric,
    batch: expected.batch,
    total_batches: expected.total_batches,
    records: expected.records,
    receipt_id:
      expected.receipt_id ?? `runless:${expected.metric}:${expected.batch}`,
    sync_run_id: expected.sync_run_id ?? null,
    batch_id: expected.batch_id ?? null,
    idempotency_key: expected.idempotency_key ?? null,
    batch_index: expected.batch,
    records_received: expected.records_received,
    records_accepted: expected.records,
    records_rejected: expected.records_rejected ?? 0,
    records_inserted_new: null,
    records_deduped_existing: null,
    records_deduped_in_batch: recordsDedupedInBatch,
    storage_result_level: "accepted_only",
    sample_window: sampleWindow,
    verification_level: "delivery_receipt",
    per_metric: {
      [expected.metric]: {
        received: expected.records_received,
        accepted: expected.records,
        rejected: expected.records_rejected ?? 0,
        inserted_new: null,
        deduped_existing: null,
        deduped_in_batch: recordsDedupedInBatch,
        sample_window: sampleWindow,
      },
    },
  });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("compatibility endpoints", () => {
  it("returns health responses", async () => {
    const server = await createApp();

    await expect(server.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({
      statusCode: 200,
      json: expect.any(Function),
    });

    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("returns readiness when dependencies are available", async () => {
    const server = await createApp("secret");
    const response = await server.inject({
      method: "GET",
      url: "/ready",
      headers: { "x-api-key": "wrong" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      database: "ok",
    });
  });

  it("fails startup when file-backed state is unavailable", async () => {
    await expect(buildApp({
      config: loadConfig({
        HOST: "127.0.0.1",
        PORT: "0",
        LOG_ENABLED: "false",
        API_KEY: "",
        MQTT_ENABLED: "false",
        STATE_BACKEND: "file",
        DATA_PATH: "/dev/null",
      }),
    })).rejects.toThrow();
  });

  it("keeps V1 readiness independent from MQTT availability", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    mqttPublisher.isReady = () => false;
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
        mqtt: {
          ...baseConfig.mqtt,
          enabled: true,
        },
      },
      mqttPublisher,
    });

    const response = await app.inject({
      method: "GET",
      url: "/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      database: "ok",
    });
  });

  it("returns unauthenticated v2 setup diagnostics", async () => {
    const server = await createApp("secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v2/setup/diagnostics",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "health-data-to-mqtt",
      kind: "HealthSave MQTT API",
      status: "ok",
      auth_required: true,
      health_endpoint: "/api/health",
      status_endpoint: "/api/apple/status",
      ingest_endpoint: "/api/apple/batch",
      latest_sync_endpoint: "/api/v2/sync/runs/latest",
      coverage_endpoint: "/api/v2/sync/coverage",
      anomalies_endpoint: "/api/v2/sync/anomalies",
      grafana_required: false,
      wrong_port_hint:
        "If you see Grafana auth JSON, Homepage HTML, or an MQTT broker response, the app is pointed at the wrong port. Use the Health Data to MQTT API base URL.",
    });
  });

  it("serves the frozen reference V1 route inventory", async () => {
    const server = await createApp();
    const cases = [
      { method: "GET", url: "/health" },
      { method: "GET", url: "/api/health" },
      { method: "GET", url: "/ready" },
      { method: "GET", url: "/metrics" },
      { method: "POST", url: "/api/apple/batch", payload: {} },
      { method: "GET", url: "/api/apple/status" },
      { method: "GET", url: "/api/insights/latest" },
      { method: "GET", url: "/api/insights/daily" },
      { method: "GET", url: "/api/insights/weekly" },
      { method: "GET", url: "/api/insights/anomalies" },
      { method: "GET", url: "/api/insights/trends" },
      { method: "POST", url: "/api/insights/trigger", payload: {} },
      { method: "GET", url: "/api/insights/runs" },
    ] as const;

    for (const testCase of cases) {
      const response = await server.inject(testCase);
      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(200);
    }
  });

  it("classifies the markdown API reference endpoints by auth surface", async () => {
    const server = await createApp("secret", {
      whoopWebhookSecret: "whoop-secret",
    });

    for (const endpoint of apiReferenceEndpoints) {
      const response = await server.inject({
        method: endpoint.method,
        url: endpoint.path,
        payload: endpoint.method === "GET" ? undefined : {},
      });

      if (endpoint.auth === "key") {
        expect(
          response.statusCode,
          `${endpoint.method} ${endpoint.path}`,
        ).toBe(401);
      } else if (endpoint.auth === "hmac") {
        expect(
          response.statusCode,
          `${endpoint.method} ${endpoint.path}`,
        ).toBe(401);
      } else {
        expect(
          response.statusCode,
          `${endpoint.method} ${endpoint.path}`,
        ).not.toBe(401);
      }
    }
  });

  it("returns v2 meta and canonical metric catalog as open endpoints", async () => {
    const server = await createApp("secret");

    const meta = await server.inject({ method: "GET", url: "/api/v2/meta" });
    const metrics = await server.inject({ method: "GET", url: "/api/v2/metrics" });

    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toEqual({
      v2_status: "active",
      versions: {
        api_contract: "1",
        ontology: "1",
        normalizer: "1",
        fusion_policy: "1",
      },
      decision_record: "ADR-0001",
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toContainEqual({
      id: "vital.heart_rate",
      display_name: "Heart Rate",
      category: "vital",
      value_type: "quantity",
      canonical_unit: "count/min",
    });
  });

  it("returns reference-shaped no-data insight and metrics responses", async () => {
    const server = await createApp();

    await expect(
      server.inject({ method: "GET", url: "/api/insights/latest" }),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        daily_briefing: null,
        weekly_summary: null,
        recent_findings: [],
      }),
    });

    expect(
      (await server.inject({ method: "GET", url: "/api/insights/daily" })).json(),
    ).toEqual({
      id: null,
      date: null,
      narrative: null,
      findings: [],
      created_at: null,
    });
    expect(
      (await server.inject({ method: "GET", url: "/api/insights/weekly" })).json(),
    ).toEqual({
      id: null,
      week_start: null,
      week_end: null,
      narrative: null,
      findings: [],
      created_at: null,
    });
    expect(
      (await server.inject({ method: "GET", url: "/api/insights/anomalies" })).json(),
    ).toEqual({ anomalies: [], count: 0 });
    expect(
      (await server.inject({ method: "GET", url: "/api/insights/trends" })).json(),
    ).toEqual({ trends: [], count: 0 });
    expect(
      (await server.inject({ method: "POST", url: "/api/insights/trigger" })).json(),
    ).toEqual({
      status: "skipped",
      run_type: "daily_briefing",
      message: "Analysis engine is not available in the MQTT bridge.",
      run_id: null,
    });
    expect(
      (await server.inject({ method: "GET", url: "/api/insights/runs" })).json(),
    ).toEqual({ runs: [], count: 0 });

    const metrics = await server.inject({ method: "GET", url: "/metrics" });
    expect(metrics.headers["content-type"]).toContain(
      "text/plain; version=0.0.4",
    );
    expect(metrics.body).toContain("hdh_ingest_batches");
    expect(metrics.body).toContain("hdh_status_query_failures");
  });

  it("validates insight query parameters like the reference surface", async () => {
    const server = await createApp();

    const invalidSince = await server.inject({
      method: "GET",
      url: "/api/insights/anomalies?since=not-a-date",
    });
    expect(invalidSince.statusCode).toBe(422);
    expect(invalidSince.json()).toEqual({ detail: "Invalid since timestamp" });

    const invalidSeverity = await server.inject({
      method: "GET",
      url: "/api/insights/anomalies?severity=panic",
    });
    expect(invalidSeverity.statusCode).toBe(422);
    expect(invalidSeverity.json()).toEqual({
      detail: "Invalid severity: panic. Allowed: alert, info, watch",
    });

    const invalidPeriod = await server.inject({
      method: "GET",
      url: "/api/insights/trends?period=zero",
    });
    expect(invalidPeriod.statusCode).toBe(422);
    expect(invalidPeriod.json()).toEqual({
      detail: "Invalid period; expected format like 30d",
    });
  });

  it("returns reference-style batch body validation errors", async () => {
    const server = await createApp();

    const invalidJson = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json()).toEqual({ detail: "invalid JSON body" });

    const invalidPayload = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: { samples: "not-json" },
    });
    expect(invalidPayload.statusCode).toBe(422);
    expect(invalidPayload.json()).toMatchObject({
      detail: [
        {
          loc: ["body", "samples"],
        },
      ],
    });
  });

  it("accepts batches without an API key when auth is disabled", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        batch_index: 0,
        total_batches: 1,
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });

    expect(response.statusCode).toBe(200);
    expectDeliveryReceipt(response.json(), {
      status: "processed",
      metric: "heart_rate",
      batch: 0,
      total_batches: 1,
      records: 1,
      records_received: 1,
      sample_window: {
        min_sample_time: "2026-04-10T12:00:00Z",
        max_sample_time: "2026-04-10T12:00:00Z",
      },
    });
  });

  it("accepts HealthSave batches larger than Fastify's default body limit", async () => {
    const server = await createApp();
    const payload = JSON.stringify({
      metric: "heart_rate",
      batch_index: 0,
      total_batches: 1,
      samples: [
        {
          date: "2026-04-10T12:00:00Z",
          qty: 72,
          source: "HealthSave",
          metadata: "x".repeat(1024 * 1024),
        },
      ],
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(Buffer.byteLength(payload)).toBeGreaterThan(1024 * 1024);
    expect(response.statusCode).toBe(200);
    expectDeliveryReceipt(response.json(), {
      status: "processed",
      metric: "heart_rate",
      batch: 0,
      total_batches: 1,
      records: 1,
      records_received: 1,
      sample_window: {
        min_sample_time: "2026-04-10T12:00:00Z",
        max_sample_time: "2026-04-10T12:00:00Z",
      },
    });
  });

  it("returns the reference-compatible empty batch response", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        batch_index: 0,
        total_batches: 1,
        samples: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expectDeliveryReceipt(response.json(), {
      status: "empty",
      metric: "heart_rate",
      batch: 0,
      total_batches: 1,
      records: 0,
      records_received: 0,
      records_deduped_in_batch: null,
    });
  });

  it("echoes HealthSave sample-window headers in delivery receipts", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: {
        "x-healthsave-sample-min-time": "2026-04-10T12:00:00.000Z",
        "x-healthsave-sample-max-time": "2026-04-10T12:05:00.000Z",
      },
      payload: {
        metric: "heart_rate",
        batch_index: 2,
        total_batches: 3,
        samples: [{ date: "2026-04-10T12:02:00Z", qty: 72 }],
      },
    });

    expect(response.statusCode).toBe(200);
    expectDeliveryReceipt(response.json(), {
      status: "processed",
      metric: "heart_rate",
      batch: 2,
      total_batches: 3,
      records: 1,
      records_received: 1,
      receipt_id: "runless:heart_rate:2",
      sample_window: {
        min_sample_time: "2026-04-10T12:00:00Z",
        max_sample_time: "2026-04-10T12:05:00Z",
      },
    });
  });

  it("derives sample windows from payload bounds when headers are absent", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "workouts",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            start: "2026-04-10T06:10:00.000Z",
            end: "2026-04-10T06:55:00.000Z",
            name: "Running",
            duration: 2700,
          },
          {
            start: "2026-04-10T07:20:00.000Z",
            end: "2026-04-10T08:05:00.000Z",
            name: "Cycling",
            duration: 2700,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expectDeliveryReceipt(response.json(), {
      status: "processed",
      metric: "workouts",
      batch: 0,
      total_batches: 1,
      records: 2,
      records_received: 2,
      sample_window: {
        min_sample_time: "2026-04-10T06:10:00.000Z",
        max_sample_time: "2026-04-10T08:05:00.000Z",
      },
    });
  });

  it("returns null sample windows for malformed HealthSave window headers", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: {
        "x-healthsave-sample-min-time": "garbage",
        "x-healthsave-sample-max-time": "also-garbage",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });

    expect(response.statusCode).toBe(200);
    expectDeliveryReceipt(response.json(), {
      status: "processed",
      metric: "heart_rate",
      batch: 0,
      total_batches: 1,
      records: 1,
      records_received: 1,
      sample_window: {
        min_sample_time: null,
        max_sample_time: null,
      },
    });
  });

  it("returns flat status objects for processed batches", async () => {
    const server = await createApp();

    await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate_variability",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 44 }],
      },
    });

    const response = await server.inject({ method: "GET", url: "/api/apple/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("status");
    expect(response.json()).not.toHaveProperty("counts");
    expect(response.json()).toEqual({
      ...emptyStatusResponse(),
      hrv: metricStatus(1, "2026-04-10T12:00:00.000Z"),
    });
  });

  it("expands oldest and newest without double-counting duplicate retries", async () => {
    const server = await createApp();

    await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    });
    await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-08T07:00:00Z", qty: 68, source: "Watch" }],
      },
    });
    await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    });

    const response = await server.inject({ method: "GET", url: "/api/apple/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      heart_rate: metricStatus(
        2,
        "2026-04-08T07:00:00.000Z",
        "2026-04-10T12:00:00.000Z",
      ),
    });
  });

  it("publishes blood oxygen aliases as normalized and current data", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "blood_oxygen",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            startDate: "2026-04-10T12:00:00Z",
            oxygenSaturation: 0.973,
            source: "Watch",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "blood_oxygen",
      records: 1,
    });
    expect(mqttPublisher.normalizedBatches[0]?.records).toMatchObject([
      {
        metric: "blood_oxygen",
        normalizedMetric: "blood_oxygen",
        normalizedSample: {
          time: "2026-04-10T12:00:00.000Z",
          spo2_pct: 97.3,
          source_id: "Watch",
        },
      },
    ]);
    expect(mqttPublisher.currentBatches[0]?.records).toMatchObject([
      {
        metric: "blood_oxygen",
        normalizedMetric: "blood_oxygen",
        normalizedSample: {
          spo2_pct: 97.3,
        },
      },
    ]);

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toMatchObject({
      blood_oxygen: metricStatus(1, "2026-04-10T12:00:00.000Z"),
    });
  });

  it("skips invalid samples in non-empty batches without changing status", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "walking_speed",
        batch_index: 0,
        total_batches: 1,
        samples: [
          { date: "not-a-date", qty: 1.2 },
          { source: "Phone" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "walking_speed",
      records: 0,
    });

    const status = await server.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toEqual(emptyStatusResponse());
  });

  it("logs structured unknown health data diagnostics for unmapped samples", async () => {
    const logStream = createRecordingLogStream();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: true,
        logLevel: "warn",
      },
      logger: {
        level: "warn",
        stream: logStream,
        redact: ["req.headers.x-api-key"],
      },
      mqttPublisher: createRecordingMqttPublisher(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "new_quantity_metric",
        batch_index: 1,
        total_batches: 2,
        samples: [
          {
            startDate: "2026-04-10T12:00:00Z",
            value: 4.2,
            sourceName: "Watch",
            healthKitIdentifier: "HKQuantityTypeIdentifierNewQuantityMetric",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "new_quantity_metric",
      records: 0,
      records_received: 1,
      records_rejected: 1,
    });
    const logEntries = logStream.lines.map((line) => JSON.parse(line) as {
      msg?: string;
      unknown_health_data?: Record<string, unknown>;
    });
    const warning = logEntries.find(
      (entry) => entry.msg === "detected unmapped apple health batch data",
    );

    expect(warning?.unknown_health_data).toMatchObject({
      schema_version: 2,
      context: "default",
      prefix: "/",
      metric: "new_quantity_metric",
      batch_index: 1,
      total_batches: 2,
      raw_records: 1,
      processed_records: 0,
      mapper: "generic_quantity_fallback",
      normalized_metric: "quantity_samples",
      unsupported_metric: true,
      total_samples: 1,
      field_summary: {
        unmapped_keys: ["healthKitIdentifier", "value"],
        candidate_time_fields: ["startDate"],
        candidate_numeric_fields: ["value"],
        categorical_preview_fields: ["healthKitIdentifier"],
        source_identity_fields: ["sourceName"],
        source_id_count: 1,
      },
      implementation_hint: {
        add_or_update_mapper_for_metric: "new_quantity_metric",
        candidate_time_fields: ["startDate"],
        candidate_value_fields: ["value"],
        candidate_metric_name_fields: ["healthKitIdentifier"],
        candidate_unit_fields: [],
        unmapped_fields: ["healthKitIdentifier", "value"],
        used_generic_fallback: true,
        accepted_through_fallback: false,
        has_rejected_samples: true,
        accepted_records: 0,
      },
      samples: [
        {
          sample_index: 0,
          reasons: [
            "unsupported_metric",
            "unmapped_sample_fields",
            "rejected_sample",
          ],
          missing_value_fields: ["qty"],
          categorical_preview_fields: ["healthKitIdentifier"],
          field_profiles: expect.arrayContaining([
            expect.objectContaining({
              field: "healthKitIdentifier",
              value_type: "string",
              preview: "HKQuantityTypeIdentifierNewQuantityMetric",
            }),
            expect.objectContaining({
              field: "sourceName",
              value_type: "string",
              roles: [
                "known_field",
                "candidate_string_field",
                "device_identity_field",
              ],
            }),
            expect.objectContaining({
              field: "value",
              value_type: "number",
              parseable_number: true,
            }),
          ]),
        },
      ],
    });
    const warningJson = JSON.stringify(warning?.unknown_health_data);
    expect(warningJson).not.toContain("4.2");
    expect(warningJson).not.toContain("Watch");
  });

  it("records v2 sync receipts for batches with HealthSave run headers", async () => {
    const server = await createApp();
    const batchResponse = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-1",
        "x-healthsave-sync-run-id": "run-1",
        "x-healthsave-batch-id": "batch-1",
        "x-healthsave-payload-hash": "hash-1",
        "x-healthsave-sample-min-time": "2026-04-10T12:00:00Z",
        "x-healthsave-sample-max-time": "2026-04-10T12:00:00Z",
      },
      payload: {
        metric: "heart_rate",
        batch_index: 0,
        total_batches: 1,
        samples: [
          { date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" },
          { date: "2026-04-10T12:00:00Z", qty: 73, source: "Watch" },
          { date: "not-a-date", qty: 74, source: "Watch" },
        ],
      },
    });

    expect(batchResponse.statusCode).toBe(200);
    expect(batchResponse.json()).toMatchObject({
      status: "processed",
      records: 1,
    });

    const latest = await server.inject({
      method: "GET",
      url: "/api/v2/sync/runs/latest",
    });
    const run = await server.inject({
      method: "GET",
      url: "/api/v2/sync/runs/run-1",
    });
    const coverage = await server.inject({
      method: "GET",
      url: "/api/v2/sync/coverage",
    });

    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({
      status: "ok",
      sync_run_id: "run-1",
      verification_level: "delivery_receipt",
      storage_result_level: "accepted_only",
      records_received: 3,
      records_accepted: 1,
      records_inserted_new: null,
      records_deduped_existing: null,
      records_rejected: 1,
      records_skipped: 1,
      records_deduped_in_batch: 1,
      batches_seen: 1,
      batches_processed: 1,
      batches_failed: 0,
      metrics: ["heart_rate"],
      sample_window: {
        min_sample_time: "2026-04-10T12:00:00Z",
        max_sample_time: "2026-04-10T12:00:00Z",
      },
      latest_sample_time: "2026-04-10T12:00:00Z",
    });
    expect(run.json()).toMatchObject(latest.json());
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json()).toMatchObject({
      status: "ok",
      storage_result_level: "accepted_only",
      count: 1,
      metrics: [
        {
          metric: "heart_rate",
          batches_seen: 1,
          records_received: 3,
          records_accepted: 1,
          records_rejected: 1,
          records_deduped_in_batch: 1,
          receipt_sample_window: {
            min_sample_time: "2026-04-10T12:00:00Z",
            max_sample_time: "2026-04-10T12:00:00Z",
          },
          latest_receipt_sample_time: "2026-04-10T12:00:00Z",
          latest_destination_sample_time: "2026-04-10T12:00:00.000Z",
          destination_row_count: 1,
        },
      ],
    });
  });

  it("serves v2 read, identity, export, changes, and receipts from accepted batches", async () => {
    const server = await createApp("secret");
    const batchResponse = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: {
        "x-api-key": "secret",
        "x-healthsave-sync-run-id": "run-read-1",
        "x-healthsave-batch-id": "batch-read-1",
      },
      payload: {
        metric: "heart_rate",
        batch_index: 0,
        total_batches: 1,
        samples: [
          { date: "2026-04-10T12:00:00Z", qty: 72, source: "Apple Watch" },
        ],
      },
    });
    expect(batchResponse.statusCode).toBe(200);

    const series = await server.inject({
      method: "GET",
      url: "/api/v2/metrics/vital.heart_rate/series?start=2026-04-10T00:00:00Z&end=2026-04-11T00:00:00Z",
      headers: { "x-api-key": "secret" },
    });
    expect(series.statusCode).toBe(200);
    expect(series.json()).toMatchObject({
      metric: { id: "vital.heart_rate" },
      points: [
        {
          t: "2026-04-10T12:00:00.000Z",
          value: 72,
          source_id: "apple_watch",
        },
      ],
    });

    const batchSeries = await server.inject({
      method: "GET",
      url: "/api/v2/series?ids=vital.heart_rate,not.a.metric&start=2026-04-10T00:00:00Z&end=2026-04-11T00:00:00Z",
      headers: { "x-api-key": "secret" },
    });
    expect(batchSeries.statusCode).toBe(200);
    expect(batchSeries.json()).toMatchObject({
      series: [
        { metric: { id: "vital.heart_rate" }, points: [{ value: 72 }] },
        { metric_id: "not.a.metric", error: "unknown metric" },
      ],
    });

    const sources = await server.inject({
      method: "GET",
      url: "/api/v2/sources?limit=10&offset=0",
      headers: { "x-api-key": "secret" },
    });
    const streams = await server.inject({
      method: "GET",
      url: "/api/v2/streams",
      headers: { "x-api-key": "secret" },
    });
    const devices = await server.inject({
      method: "GET",
      url: "/api/v2/devices",
      headers: { "x-api-key": "secret" },
    });
    expect(sources.json()).toMatchObject({
      count: 1,
      total: 1,
      sources: [{ plugin_id: "apple-healthkit-ios" }],
    });
    expect(streams.json()).toMatchObject({
      count: 1,
      total: 1,
      streams: [{ device_label: "Apple Watch", source_plugin_id: "apple-healthkit-ios" }],
    });
    expect(devices.json()).toMatchObject({
      count: 1,
      total: 1,
      devices: [{ device_label: "Apple Watch", stream_count: 1 }],
    });

    const streamId = streams.json().streams[0].id as string;
    expect(streamId).toMatch(/^[0-9a-f-]{36}$/);
    const stream = await server.inject({
      method: "GET",
      url: `/api/v2/streams/${streamId}`,
      headers: { "x-api-key": "secret" },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.json()).toMatchObject({ id: streamId, device_label: "Apple Watch" });

    const readiness = await server.inject({
      method: "GET",
      url: "/api/v2/readiness",
      headers: { "x-api-key": "secret" },
    });
    expect(readiness.json()).toMatchObject({
      summary: { metrics_with_data: 1 },
      metrics: [
        {
          metric_id: "vital.heart_rate",
          observation_count: 1,
          days_with_data: 1,
        },
      ],
    });

    const exportMetrics = await server.inject({
      method: "GET",
      url: "/api/v2/export/metrics",
      headers: { "x-api-key": "secret" },
    });
    expect(exportMetrics.json()).toEqual([
      {
        metric: "vital.heart_rate",
        display_name: "Heart Rate",
        count: 1,
        oldest: "2026-04-10T12:00:00.000Z",
        newest: "2026-04-10T12:00:00.000Z",
      },
    ]);

    const exported = await server.inject({
      method: "GET",
      url: "/api/v2/export?metric=vital.heart_rate",
      headers: { "x-api-key": "secret" },
    });
    expect(exported.json()).toMatchObject({
      count: 1,
      rows: [{ metric_id: "vital.heart_rate", value: 72 }],
    });
    const exportedCsv = await server.inject({
      method: "GET",
      url: "/api/v2/export?metric=vital.heart_rate&format=csv",
      headers: { "x-api-key": "secret" },
    });
    expect(exportedCsv.headers["content-type"]).toContain("text/csv");
    expect(exportedCsv.body).toContain("metric_id");
    expect(exportedCsv.body).toContain("vital.heart_rate");

    const changes = await server.inject({
      method: "GET",
      url: "/api/v2/changes",
      headers: { "x-api-key": "secret" },
    });
    expect(changes.statusCode).toBe(200);
    expect(changes.json()).toMatchObject({
      last_ingested_at: expect.any(String),
      latest_sync_run: {
        sync_run_id: "run-read-1",
      },
      last_narrative_at: null,
      version_token: expect.any(String),
    });
    const notModified = await server.inject({
      method: "GET",
      url: "/api/v2/changes",
      headers: {
        "x-api-key": "secret",
        "if-none-match": changes.headers.etag as string,
      },
    });
    expect(notModified.statusCode).toBe(304);

    const receipts = await server.inject({
      method: "GET",
      url: "/api/v2/receipts",
      headers: { "x-api-key": "secret" },
    });
    expect(receipts.json()).toMatchObject({
      events_unavailable: false,
      count: 0,
      ingest: {
        sources: [{ source_plugin_id: "apple-healthkit-ios" }],
        latest_sync_run: { sync_run_id: "run-read-1" },
      },
    });
  });

  it("does not expose v2 sync receipts for batches without a sync run id", async () => {
    const server = await createApp();
    await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-1",
        "x-healthsave-payload-hash": "hash-1",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });

    const latest = await server.inject({
      method: "GET",
      url: "/api/v2/sync/runs/latest",
    });
    const run = await server.inject({
      method: "GET",
      url: "/api/v2/sync/runs/run-1",
    });
    const coverage = await server.inject({
      method: "GET",
      url: "/api/v2/sync/coverage",
    });

    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({
      status: "empty",
      sync_run_id: null,
      verification_level: "none",
      records_received: 0,
      records_accepted: 0,
      records_rejected: 0,
      batches_seen: 0,
      batches_processed: 0,
      batches_failed: 0,
      metrics: [],
    });
    expect(run.statusCode).toBe(404);
    expect(run.json()).toEqual({
      status: "not_found",
      error: "Sync run not found",
      sync_run_id: "run-1",
    });
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json()).toEqual({
      status: "ok",
      storage_result_level: "accepted_only",
      count: 0,
      summary: {
        metrics_seen: 0,
        batches_seen: 0,
        records_received: 0,
        records_accepted: 0,
        records_inserted_new: null,
        records_deduped_existing: null,
        records_skipped: 0,
      },
      metrics: [],
    });
  });

  it("returns typed empty or no-op shapes for unavailable v2 engines", async () => {
    const server = await createApp("secret");
    const headers = { "x-api-key": "secret" };

    await expect(
      server.inject({ method: "GET", url: "/api/v2/insights/latest", headers }),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: JSON.stringify({
        daily_briefing: null,
        weekly_summary: null,
        recent_findings: [],
        runs: {
          daily_briefing: null,
          weekly_summary: null,
        },
      }),
    });
    expect(
      (await server.inject({ method: "GET", url: "/api/v2/insights/findings", headers })).json(),
    ).toEqual({ findings: [], count: 0 });
    expect(
      (await server.inject({ method: "GET", url: "/api/v2/insights/correlations", headers })).json(),
    ).toEqual({ correlations: [], count: 0 });
    expect(
      (await server.inject({ method: "GET", url: "/api/v2/insights/narratives", headers })).json(),
    ).toEqual({ narratives: [], count: 0, limit: 20 });
    expect(
      (await server.inject({
        method: "POST",
        url: "/api/v2/insights/trigger",
        headers,
        payload: { type: "weekly_summary" },
      })).json(),
    ).toMatchObject({
      status: "skipped",
      run_type: "weekly_summary",
      run_id: null,
    });
    expect(
      (await server.inject({ method: "GET", url: "/api/v2/sync/anomalies", headers })).json(),
    ).toEqual({ status: "ok", count: 0, anomalies: [] });
    expect(
      (await server.inject({ method: "GET", url: "/api/v2/experiments/candidates", headers })).json(),
    ).toEqual({ candidates: [], count: 0, testable_count: 0 });
    expect(
      (await server.inject({ method: "GET", url: "/api/v2/agents/proposals", headers })).json(),
    ).toEqual({ count: 0, undecided_only: true, proposals: [] });
  });

  it("creates and updates lightweight v2 experiments", async () => {
    const server = await createApp("secret");
    const headers = { "x-api-key": "secret" };

    const created = await server.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers,
      payload: {
        lever_metric_id: "intake.caffeine_mg",
        outcome_metric_id: "sleep.efficiency",
        hypothesis: "Less caffeine improves sleep",
        design: "AB",
        block_days: 7,
        start_date: "2026-06-01",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: "running",
      lever_metric_id: "intake.caffeine_mg",
      outcome_metric_id: "sleep.efficiency",
      block_days: 7,
      start_date: "2026-06-01",
    });

    const experimentId = created.json().id as string;
    expect(
      (await server.inject({
        method: "GET",
        url: "/api/v2/experiments",
        headers,
      })).json(),
    ).toMatchObject({ count: 1, experiments: [{ id: experimentId }] });
    expect(
      (await server.inject({
        method: "GET",
        url: `/api/v2/experiments/${experimentId}`,
        headers,
      })).json(),
    ).toMatchObject({ id: experimentId, status: "running" });
    expect(
      (await server.inject({
        method: "POST",
        url: `/api/v2/experiments/${experimentId}/analyze`,
        headers,
      })).json(),
    ).toMatchObject({ id: experimentId, status: "analyzed" });
    expect(
      (await server.inject({
        method: "POST",
        url: `/api/v2/experiments/${experimentId}/abandon`,
        headers,
      })).json(),
    ).toMatchObject({ id: experimentId, status: "abandoned" });
  });

  it("stores v2 intelligence posture without returning provider secrets", async () => {
    const server = await createApp("secret");
    const headers = { "x-api-key": "secret" };

    const updated = await server.inject({
      method: "PUT",
      url: "/api/v2/intelligence",
      headers,
      payload: {
        mode: "cloud",
        primary: {
          provider: "deepseek",
          model: "deepseek/deepseek-chat",
          api_key: "sk-testabcd",
        },
        redact_cloud_prompts: true,
        fallback: [],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      mode: "cloud",
      revision: 1,
      primary: {
        provider: "deepseek",
        model: "deepseek/deepseek-chat",
        destination: "cloud",
        key_last4: "abcd",
      },
    });
    expect(JSON.stringify(updated.json())).not.toContain("sk-testabcd");

    const consent = await server.inject({
      method: "POST",
      url: "/api/v2/intelligence/consent",
      headers,
      payload: { granted: true, consent_version: "2026-06" },
    });
    expect(consent.statusCode).toBe(200);
    expect(consent.json()).toMatchObject({
      granted: true,
      version: "2026-06",
      at: expect.any(String),
    });
    expect(
      (await server.inject({ method: "GET", url: "/api/v2/privacy", headers })).json(),
    ).toMatchObject({
      provider: "deepseek",
      destination: "cloud",
      allow_cloud_egress: true,
      raw_observations_leave_host: false,
    });
    expect(
      (await server.inject({
        method: "POST",
        url: "/api/v2/intelligence/test-connection",
        headers,
        payload: { provider: "deepseek", model: "deepseek/deepseek-chat" },
      })).json(),
    ).toMatchObject({ ok: true, destination: "cloud" });
    expect(
      (await server.inject({
        method: "GET",
        url: "/api/v2/intelligence/detect-local",
        headers,
      })).json(),
    ).toMatchObject({ candidates: expect.any(Array) });

    const receipts = await server.inject({
      method: "GET",
      url: "/api/v2/receipts",
      headers,
    });
    expect(receipts.json()).toMatchObject({
      count: 3,
      events: expect.arrayContaining([
        expect.objectContaining({ event_type: "intelligence_settings_updated" }),
        expect.objectContaining({ event_type: "consent_granted" }),
        expect.objectContaining({ event_type: "provider_healthcheck" }),
      ]),
    });
  });

  it("verifies Whoop webhook signatures when a secret is configured", async () => {
    const server = await createApp("", {
      whoopWebhookSecret: "whoop-secret",
    });
    const payload = { event: "ping" };
    const timestamp = "2026-06-19T12:00:00Z";

    const unauthorized = await server.inject({
      method: "POST",
      url: "/api/v2/sources/whoop/webhook",
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await server.inject({
      method: "POST",
      url: "/api/v2/sources/whoop/webhook",
      headers: {
        "x-whoop-timestamp": timestamp,
        "x-whoop-signature": createWhoopSignature(
          "whoop-secret",
          timestamp,
          JSON.stringify(payload),
        ),
      },
      payload,
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({
      status: "accepted",
      received: true,
    });
  });

  it("counts blood pressure correlations as separate quantity samples", async () => {
    const server = await createApp();

    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "blood_pressure",
        samples: [
          {
            metric: "blood_pressure_systolic",
            date: "2026-04-10T09:00:00Z",
            qty: 120,
            source: "Monitor",
          },
          {
            metric: "blood_pressure_diastolic",
            date: "2026-04-10T09:00:00Z",
            qty: 80,
            source: "Monitor",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "blood_pressure",
      records: 2,
    });

    const status = await server.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toMatchObject({
      quantity_samples: metricStatus(
        2,
        "2026-04-10T09:00:00.000Z",
        "2026-04-10T09:00:00.000Z",
      ),
    });
  });

  it("processes body temperature without exposing it in public status", async () => {
    const server = await createApp();

    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "wrist_temperature",
        samples: [
          {
            date: "2026-04-10T12:00:00Z",
            qty: 32.6,
            deviceName: "Apple Watch",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "wrist_temperature",
      records: 1,
    });

    const status = await server.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toEqual(emptyStatusResponse());
  });

  it("persists status counters in the configured data path", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "health-api-state-"));
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_ENABLED: "false",
      API_KEY: "",
      MQTT_ENABLED: "false",
      STATE_BACKEND: "file",
      DATA_PATH: tempDirectory,
    });

    app = await buildApp({ config });
    await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });
    await app.close();

    app = await buildApp({ config });
    const response = await app.inject({ method: "GET", url: "/api/apple/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      heart_rate: metricStatus(1, "2026-04-10T12:00:00.000Z"),
    });
  });

  it("fails startup instead of exposing partial status when sqlite cannot open", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "health-api-state-fail-"));
    await mkdir(join(tempDirectory, "status", "status.sqlite"), {
      recursive: true,
    });
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_ENABLED: "false",
      API_KEY: "",
      MQTT_ENABLED: "false",
      STATE_BACKEND: "file",
      DATA_PATH: tempDirectory,
    });

    await expect(buildApp({ config })).rejects.toThrow();
  });

  it("publishes daily quantity datapoints to MQTT before accepting batches", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "step_count",
        batch_index: 3,
        total_batches: 5,
        samples: [
          { date: "2026-04-10T12:00:00Z", qty: 120 },
          { date: "2026-04-10T12:01:00Z", qty: 125 },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "step_count",
      records: 1,
    });
    expect(mqttPublisher.batches[0]).toMatchObject({
      context: { name: "default", prefix: "/" },
      batch: {
        metric: "step_count",
        batch_index: 3,
        total_batches: 5,
        samples: [
          { date: "2026-04-10T12:00:00Z", qty: 120 },
          { date: "2026-04-10T12:01:00Z", qty: 125 },
        ],
      },
    });
    expect(mqttPublisher.normalizedBatches[0]?.records).toMatchObject([
      {
        metric: "step_count",
        normalizedMetric: "daily_activity",
        normalizedSample: {
          date: "2026-04-10",
          steps: 125,
        },
      },
    ]);
    expect(mqttPublisher.currentBatches[0]?.records).toMatchObject([
      {
        metric: "step_count",
        normalizedMetric: "daily_activity",
        normalizedSample: {
          date: "2026-04-10",
          steps: 125,
        },
      },
    ]);

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toMatchObject({
      daily_activity: metricStatus(1, "2026-04-10"),
      quantity_samples: emptyMetricStatus(),
    });
  });

  it("publishes workouts active energy as normalized and current data", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "workouts",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            duration: 2596,
            source: "Runkeeper",
            start: "2016-01-20T13:59:13.337Z",
            distance: 15000,
            name: "Cycling",
            maxHeartRate: 105,
            activeEnergy: 366.3367462222223,
            end: "2016-01-20T14:42:29.337Z",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "workouts",
      records: 1,
    });
    expect(mqttPublisher.normalizedBatches[0]?.records).toMatchObject([
      {
        metric: "workouts",
        normalizedMetric: "workouts",
        normalizedSample: {
          start_time: "2016-01-20T13:59:13.337Z",
          end_time: "2016-01-20T14:42:29.337Z",
          sport_type: "Cycling",
          duration_ms: 2_596_000,
          max_hr: 105,
          calories: 366.3367462222223,
          distance_m: 15000,
        },
      },
    ]);
    expect(mqttPublisher.currentBatches[0]?.records).toMatchObject([
      {
        metric: "workouts",
        normalizedMetric: "workouts",
        normalizedSample: {
          calories: 366.3367462222223,
        },
      },
    ]);

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toMatchObject({
      workouts: metricStatus(1, "2016-01-20T13:59:13.337Z"),
    });
  });

  it("publishes sleep awake state as normalized and current data", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "sleep_analysis",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            startDate: "2026-04-10T22:00:00Z",
            endDate: "2026-04-11T06:00:00Z",
            value: "core",
          },
          {
            startDate: "2026-04-11T06:00:00Z",
            endDate: "2026-04-11T06:15:00Z",
            value: "awake",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "sleep_analysis",
      records: 1,
    });
    expect(mqttPublisher.normalizedBatches[0]?.records).toMatchObject([
      {
        metric: "sleep_analysis",
        normalizedMetric: "sleep_sessions",
        normalizedSample: {
          total_duration_ms: 28_800_000,
          light_ms: 28_800_000,
          awake_ms: 900_000,
          awake: true,
        },
      },
    ]);
    expect(mqttPublisher.currentBatches[0]?.records).toMatchObject([
      {
        metric: "sleep_analysis",
        normalizedMetric: "sleep_sessions",
        normalizedSample: {
          awake: true,
        },
      },
    ]);

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toMatchObject({
      sleep_sessions: metricStatus(1, "2026-04-10T22:00:00.000Z"),
    });
  });

  it("stores non-empty valid batches before accepting them", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "health-api-raw-storage-"));
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
        rawStoragePath: tempDirectory,
      },
      mqttPublisher,
    });

    const payload = {
      metric: "heart_rate",
      batch_index: 0,
      total_batches: 1,
      samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload,
    });

    expect(response.statusCode).toBe(200);
    const [archiveFile] = await readdir(join(tempDirectory, "default"));
    expect(archiveFile).toMatch(/^\d{4}-\d{2}$/);

    const archiveContent = await readFile(
      join(tempDirectory, "default", archiveFile!),
      "utf8",
    );
    const archiveRecord = JSON.parse(archiveContent.trim()) as Record<
      string,
      unknown
    >;

    expect(archiveRecord).toMatchObject({
      context: "default",
      metric: "heart_rate",
      batch_index: 0,
      total_batches: 1,
      body: payload,
    });
    expect(archiveRecord.ingested_at).toEqual(expect.any(String));
    expect(mqttPublisher.batches).toHaveLength(1);
  });

  it("archives the original wrapped request body and publishes real MQTT topics end-to-end", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "health-api-raw-storage-"));
    const client = createRecordingPublishClient();
    const mqttPublisher = createMqttPublisherFromClient(client, {
      ...baseConfig,
      logEnabled: false,
    });
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
        rawStoragePath: tempDirectory,
      },
      mqttPublisher,
    });

    const rawPayload = {
      metric: "ignored-by-parser",
      batch_index: 99,
      total_batches: 100,
      data: JSON.stringify({
        metric: "step_count",
        batch_index: 3,
        total_batches: 5,
        samples: [
          {
            payload: JSON.stringify({
              date: "2026-04-10T12:00:00Z",
              qty: 120,
            }),
          },
          {
            payload: JSON.stringify({
              date: "2026-04-10T12:01:00Z",
              qty: 125,
            }),
          },
        ],
      }),
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: rawPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "step_count",
      batch: 3,
      total_batches: 5,
      records: 1,
    });

    const [archiveFile] = await readdir(join(tempDirectory, "default"));
    const archiveContent = await readFile(
      join(tempDirectory, "default", archiveFile!),
      "utf8",
    );
    expect(JSON.parse(archiveContent.trim())).toMatchObject({
      context: "default",
      metric: "step_count",
      batch_index: 3,
      total_batches: 5,
      body: rawPayload,
    });

    expect(client.publishCalls.map((call) => call.topic)).toEqual([
      "healthsave/raw/step_count",
      "healthsave/raw/step_count",
      "healthsave/normalized/daily_activity",
      "healthsave/current/daily_activity/steps",
    ]);
  });

  it("does not store empty batches", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "health-api-raw-storage-"));
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
        rawStoragePath: tempDirectory,
      },
      mqttPublisher: createRecordingMqttPublisher(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        batch_index: 0,
        total_batches: 1,
        samples: [],
      },
    });

    expect(response.statusCode).toBe(200);
    await expect(readdir(join(tempDirectory, "default"))).rejects.toThrow();
  });

  it("publishes correlated quantity metrics to per-sample MQTT topics end-to-end", async () => {
    const client = createRecordingPublishClient();
    const mqttPublisher = createMqttPublisherFromClient(client, {
      ...baseConfig,
      logEnabled: false,
    });
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "blood_pressure",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            metric: "blood_pressure_systolic",
            date: "2026-04-10T09:00:00Z",
            qty: 120,
            source: "Monitor",
          },
          {
            metric: "blood_pressure_diastolic",
            date: "2026-04-10T09:00:00Z",
            qty: 80,
            source: "Monitor",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processed",
      metric: "blood_pressure",
      records: 2,
    });
    expect(client.publishCalls.map((call) => call.topic)).toEqual([
      "healthsave/raw/blood_pressure",
      "healthsave/raw/blood_pressure",
      "healthsave/normalized/blood_pressure_systolic",
      "healthsave/normalized/blood_pressure_diastolic",
      "healthsave/current/blood_pressure_systolic",
      "healthsave/current/blood_pressure_diastolic",
    ]);
  });

  it("rejects batches before MQTT and status updates when raw storage fails", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    const failingRawStorage: RawBatchStorage = {
      async storeBatch() {
        throw new Error("disk unavailable");
      },
    };
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
      rawBatchStorage: failingRawStorage,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      status: "error",
      error: "Failed to store raw batch",
    });
    expect(mqttPublisher.batches).toHaveLength(0);
    expect(mqttPublisher.normalizedBatches).toHaveLength(0);
    expect(mqttPublisher.currentBatches).toHaveLength(0);

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toEqual(emptyStatusResponse());
  });

  it("supports prefixed context endpoints with isolated status counts", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
        contexts: [
          baseConfig.contexts[0]!,
          {
            name: "daniel",
            prefix: "/daniel",
            mqtt: {
              topics: {
                raw: "healthsave/daniel/raw/{metric}",
                normalized: "healthsave/daniel/normalized/{metric}",
                current: "healthsave/daniel/current/{metric}",
              },
            },
          },
        ],
      },
      mqttPublisher,
    });

    await app.inject({
      method: "POST",
      url: "/daniel/api/apple/batch",
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });

    const defaultStatus = await app.inject({
      method: "GET",
      url: "/api/apple/status",
    });
    const danielStatus = await app.inject({
      method: "GET",
      url: "/daniel/api/apple/status",
    });

    expect(defaultStatus.json()).toEqual(emptyStatusResponse());
    expect(danielStatus.json()).toMatchObject({
      heart_rate: metricStatus(1, "2026-04-10T12:00:00.000Z"),
    });
    expect(mqttPublisher.batches[0]?.context.name).toBe("daniel");
    expect(mqttPublisher.normalizedBatches[0]?.context.name).toBe("daniel");
    expect(mqttPublisher.currentBatches[0]?.context.name).toBe("daniel");
  });

  it("isolates prefixed v2 diagnostics and sync receipts", async () => {
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
        contexts: [
          baseConfig.contexts[0]!,
          {
            name: "daniel",
            prefix: "/daniel",
            mqtt: {
              topics: {
                raw: "healthsave/daniel/raw/{metric}",
                normalized: "healthsave/daniel/normalized/{metric}",
                current: "healthsave/daniel/current/{metric}",
              },
            },
          },
        ],
      },
      mqttPublisher: createRecordingMqttPublisher(),
    });

    const diagnostics = await app.inject({
      method: "GET",
      url: "/daniel/api/v2/setup/diagnostics",
    });
    await app.inject({
      method: "POST",
      url: "/daniel/api/apple/batch",
      headers: {
        "idempotency-key": "daniel-key-1",
        "x-healthsave-sync-run-id": "daniel-run-1",
        "x-healthsave-payload-hash": "daniel-hash-1",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });

    const defaultLatest = await app.inject({
      method: "GET",
      url: "/api/v2/sync/runs/latest",
    });
    const danielLatest = await app.inject({
      method: "GET",
      url: "/daniel/api/v2/sync/runs/latest",
    });

    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({
      health_endpoint: "/daniel/api/health",
      status_endpoint: "/daniel/api/apple/status",
      ingest_endpoint: "/daniel/api/apple/batch",
      latest_sync_endpoint: "/daniel/api/v2/sync/runs/latest",
      coverage_endpoint: "/daniel/api/v2/sync/coverage",
      anomalies_endpoint: "/daniel/api/v2/sync/anomalies",
    });
    expect(defaultLatest.statusCode).toBe(200);
    expect(defaultLatest.json()).toMatchObject({
      status: "empty",
      sync_run_id: null,
      metrics: [],
    });
    expect(danielLatest.statusCode).toBe(200);
    expect(danielLatest.json()).toMatchObject({
      sync_run_id: "daniel-run-1",
      metrics: ["heart_rate"],
    });
  });

  it("stores prefixed context batches under their context directory", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "health-api-raw-storage-"));
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
        rawStoragePath: tempDirectory,
        contexts: [
          baseConfig.contexts[0]!,
          {
            name: "daniel",
            prefix: "/daniel",
            mqtt: {
              topics: {
                raw: "healthsave/daniel/raw/{metric}",
                normalized: "healthsave/daniel/normalized/{metric}",
                current: "healthsave/daniel/current/{metric}",
              },
            },
          },
        ],
      },
      mqttPublisher: createRecordingMqttPublisher(),
    });

    await app.inject({
      method: "POST",
      url: "/daniel/api/apple/batch",
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });

    const [archiveFile] = await readdir(join(tempDirectory, "daniel"));
    const archiveContent = await readFile(
      join(tempDirectory, "daniel", archiveFile!),
      "utf8",
    );

    expect(JSON.parse(archiveContent.trim())).toMatchObject({
      context: "daniel",
      metric: "heart_rate",
    });
  });

  it("rejects non-empty batches when MQTT publication fails", async () => {
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher: {
        async publishRawBatch() {
          throw new Error("broker unavailable");
        },
        async publishNormalizedBatch() {
          return {
            records: 0,
            topics: [],
          };
        },
        async publishCurrentBatch() {
          return {
            records: 0,
            topics: [],
          };
        },
        isReady() {
          return true;
        },
        async close() {
          return undefined;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      status: "error",
      error: "Failed to publish batch to MQTT",
    });

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toEqual(emptyStatusResponse());
  });

  it("records failed sync-run receipts and allows a later retry to succeed", async () => {
    const syncReceiptStore = createMemorySyncReceiptStore();
    const request = {
      method: "POST" as const,
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-failed-then-ok",
        "x-healthsave-sync-run-id": "run-failed-then-ok",
        "x-healthsave-batch-id": "batch-1",
        "x-healthsave-payload-hash": "hash-failed-then-ok",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    };

    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      syncReceiptStore,
      mqttPublisher: {
        async publishRawBatch() {
          throw new Error("broker unavailable");
        },
        async publishNormalizedBatch() {
          return {
            records: 0,
            topics: [],
          };
        },
        async publishCurrentBatch() {
          return {
            records: 0,
            topics: [],
          };
        },
        isReady() {
          return true;
        },
        async close() {
          return undefined;
        },
      },
    });
    const failed = await app.inject(request);
    const failedRun = await app.inject({
      method: "GET",
      url: "/api/v2/sync/runs/run-failed-then-ok",
    });
    await app.close();

    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      syncReceiptStore,
      mqttPublisher,
    });
    const retried = await app.inject(request);
    const retriedRun = await app.inject({
      method: "GET",
      url: "/api/v2/sync/runs/run-failed-then-ok",
    });

    expect(failed.statusCode).toBe(502);
    expect(failedRun.statusCode).toBe(200);
    expect(failedRun.json()).toMatchObject({
      sync_run_id: "run-failed-then-ok",
      records_received: 1,
      records_accepted: 0,
      batches_seen: 1,
      batches_processed: 0,
      batches_failed: 1,
    });
    expect(retried.statusCode).toBe(200);
    expect(mqttPublisher.batches).toHaveLength(1);
    expect(retriedRun.json()).toMatchObject({
      sync_run_id: "run-failed-then-ok",
      records_received: 2,
      records_accepted: 1,
      batches_seen: 1,
      batches_processed: 1,
      batches_failed: 1,
    });
  });

  it("requires the configured API key on protected endpoints", async () => {
    const server = await createApp("secret");

    const unauthorized = await server.inject({
      method: "GET",
      url: "/api/apple/status",
      headers: { "x-api-key": "wrong" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ detail: "Invalid API key" });

    const authorized = await server.inject({
      method: "GET",
      url: "/api/apple/status",
      headers: { "x-api-key": "secret" },
    });

    expect(authorized.statusCode).toBe(200);
  });

  it("requires the configured API key on protected v2 sync endpoints", async () => {
    const server = await createApp("secret");

    const unauthorized = await server.inject({
      method: "GET",
      url: "/api/v2/sync/runs/latest",
      headers: { "x-api-key": "wrong" },
    });
    const diagnostics = await server.inject({
      method: "GET",
      url: "/api/v2/setup/diagnostics",
      headers: { "x-api-key": "wrong" },
    });
    const authorized = await server.inject({
      method: "GET",
      url: "/api/v2/sync/runs/latest",
      headers: { "x-api-key": "secret" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ detail: "Invalid API key" });
    expect(diagnostics.statusCode).toBe(200);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({
      status: "empty",
      sync_run_id: null,
    });
  });

  it("replays idempotency keys without sync run ids", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });
    const request = {
      method: "POST" as const,
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-no-run",
        "x-healthsave-payload-hash": "hash-no-run",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(mqttPublisher.batches).toHaveLength(1);

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    const latest = await app.inject({
      method: "GET",
      url: "/api/v2/sync/runs/latest",
    });

    expect(status.json()).toMatchObject({
      heart_rate: metricStatus(1, "2026-04-10T12:00:00.000Z"),
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({
      status: "empty",
      sync_run_id: null,
      batches_seen: 0,
      metrics: [],
    });
  });

  it("uses X-HealthSave-Batch-ID as an idempotency fallback", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });
    const request = {
      method: "POST" as const,
      url: "/api/apple/batch",
      headers: {
        "x-healthsave-batch-id": "batch-fallback-1",
        "x-healthsave-payload-hash": "hash-batch-fallback",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(second.json()).toEqual(first.json());
    expect(second.json()).toMatchObject({
      receipt_id: "batch-fallback-1",
      batch_id: "batch-fallback-1",
      idempotency_key: "batch-fallback-1",
    });
    expect(mqttPublisher.batches).toHaveLength(1);
  });

  it("uses sync-run metric and batch index as an idempotency fallback", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });
    const request = {
      method: "POST" as const,
      url: "/api/apple/batch",
      headers: {
        "x-healthsave-sync-run-id": "run-fallback-1",
        "x-healthsave-payload-hash": "hash-run-fallback",
      },
      payload: {
        metric: "heart_rate",
        batch_index: 3,
        total_batches: 4,
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(second.json()).toEqual(first.json());
    expect(second.json()).toMatchObject({
      receipt_id: "run-fallback-1:heart_rate:3",
      sync_run_id: "run-fallback-1",
      idempotency_key: "run-fallback-1:heart_rate:3",
    });
    expect(mqttPublisher.batches).toHaveLength(1);
  });

  it("rejects idempotency hash conflicts without sync run ids before side effects", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });

    await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-no-run",
        "x-healthsave-payload-hash": "hash-1",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-no-run",
        "x-healthsave-payload-hash": "hash-2",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-11T12:00:00Z", qty: 75, source: "Watch" }],
      },
    });

    expect(conflict.statusCode).toBe(409);
    expect(mqttPublisher.batches).toHaveLength(1);

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toMatchObject({
      heart_rate: metricStatus(1, "2026-04-10T12:00:00.000Z"),
    });
  });

  it("persists idempotency keys across file-backed app restarts", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "health-idempotency-api-"));
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_ENABLED: "false",
      API_KEY: "",
      MQTT_ENABLED: "false",
      STATE_BACKEND: "file",
      DATA_PATH: tempDirectory,
    });
    const request = {
      method: "POST" as const,
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-persisted",
        "x-healthsave-payload-hash": "hash-persisted",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    };

    app = await buildApp({ config });
    const first = await app.inject(request);
    await app.close();

    app = await buildApp({ config });
    const second = await app.inject(request);
    const status = await app.inject({ method: "GET", url: "/api/apple/status" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(status.json()).toMatchObject({
      heart_rate: metricStatus(1, "2026-04-10T12:00:00.000Z"),
    });
  });

  it("replays matching idempotency keys without repeating ingest side effects", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });
    const request = {
      method: "POST" as const,
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-1",
        "x-healthsave-sync-run-id": "run-1",
        "x-healthsave-payload-hash": "hash-1",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(mqttPublisher.batches).toHaveLength(1);
    expect(mqttPublisher.normalizedBatches).toHaveLength(1);
    expect(mqttPublisher.currentBatches).toHaveLength(1);

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    const latest = await app.inject({
      method: "GET",
      url: "/api/v2/sync/runs/latest",
    });

    expect(status.json()).toMatchObject({
      heart_rate: metricStatus(1, "2026-04-10T12:00:00.000Z"),
    });
    expect(latest.json()).toMatchObject({
      sync_run_id: "run-1",
      batches_processed: 1,
      records_received: 1,
      records_accepted: 1,
    });
  });

  it("rejects reused idempotency keys with different payload hashes before side effects", async () => {
    const mqttPublisher = createRecordingMqttPublisher();
    app = await buildApp({
      config: {
        ...baseConfig,
        logEnabled: false,
      },
      mqttPublisher,
    });

    await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-1",
        "x-healthsave-sync-run-id": "run-1",
        "x-healthsave-payload-hash": "hash-1",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" }],
      },
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/apple/batch",
      headers: {
        "idempotency-key": "key-1",
        "x-healthsave-sync-run-id": "run-1",
        "x-healthsave-payload-hash": "hash-2",
      },
      payload: {
        metric: "heart_rate",
        samples: [{ date: "2026-04-11T12:00:00Z", qty: 75, source: "Watch" }],
      },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      detail: {
        status: "rejected",
        error_code: "idempotency_key_payload_mismatch",
        message:
          "This idempotency key was already received with a different payload hash.",
      },
    });
    expect(mqttPublisher.batches).toHaveLength(1);

    const status = await app.inject({ method: "GET", url: "/api/apple/status" });
    const latest = await app.inject({
      method: "GET",
      url: "/api/v2/sync/runs/latest",
    });

    expect(status.json()).toMatchObject({
      heart_rate: metricStatus(1, "2026-04-10T12:00:00.000Z"),
    });
    expect(latest.json()).toMatchObject({
      sync_run_id: "run-1",
      batches_processed: 1,
      records_received: 1,
    });
  });
});
