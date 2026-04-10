import { mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig, type AppContextConfig } from "../../src/config.js";
import type { BatchRequest, NormalizedRecord } from "../../src/ingest.js";
import type {
  CurrentPublishResult,
  HealthMqttPublisher,
  NormalizedPublishResult,
  RawPublishResult,
} from "../../src/mqtt/publisher.js";
import type { RawBatchStorage } from "../../src/storage/raw-batch-storage.js";

const baseConfig = loadConfig({
  HOST: "127.0.0.1",
  PORT: "0",
  LOG_ENABLED: "false",
  API_KEY: "",
  STATE_BACKEND: "memory",
});

let app: FastifyInstance | undefined;
let tempDirectory: string | undefined;

async function createApp(apiKey = "") {
  app = await buildApp({
    config: {
      ...baseConfig,
      apiKey,
      logEnabled: false,
      mqtt: {
        ...baseConfig.mqtt,
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
    async close() {
      return undefined;
    },
  };
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
    expect(response.json()).toEqual({
      status: "processed",
      metric: "heart_rate",
      batch: 0,
      total_batches: 1,
      records: 1,
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
    expect(response.json()).toEqual({
      status: "processed",
      metric: "heart_rate",
      batch: 0,
      total_batches: 1,
      records: 1,
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
    expect(response.json()).toEqual({
      status: "empty",
      metric: "heart_rate",
      batch: 0,
      records: 0,
    });
  });

  it("tracks status counters for processed batches", async () => {
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
    expect(response.json()).toEqual({
      status: "ok",
      counts: {
        heart_rate: 0,
        hrv: 1,
        blood_oxygen: 0,
        daily_activity: 0,
        sleep_sessions: 0,
        workouts: 0,
        quantity_samples: 0,
      },
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
      counts: {
        blood_oxygen: 1,
      },
    });
  });

  it("counts accepted samples when a non-empty batch has no normalized records", async () => {
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
      records: 2,
    });

    const status = await server.inject({ method: "GET", url: "/api/apple/status" });
    expect(status.json()).toMatchObject({
      counts: {
        quantity_samples: 2,
      },
    });
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
      counts: {
        heart_rate: 1,
      },
    });
  });

  it("publishes extracted datapoints to MQTT before accepting batches", async () => {
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
      records: 2,
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
        normalizedMetric: "quantity_samples",
        normalizedSample: {
          time: "2026-04-10T12:00:00.000Z",
          metric_name: "step_count",
          value: 120,
        },
      },
      {
        metric: "step_count",
        normalizedMetric: "quantity_samples",
        normalizedSample: {
          time: "2026-04-10T12:01:00.000Z",
          metric_name: "step_count",
          value: 125,
        },
      },
    ]);
    expect(mqttPublisher.currentBatches[0]?.records).toHaveLength(2);
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
      counts: {
        workouts: 1,
      },
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
      counts: {
        sleep_sessions: 1,
      },
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
    expect(status.json()).toMatchObject({
      counts: {
        heart_rate: 0,
      },
    });
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

    expect(defaultStatus.json()).toMatchObject({
      counts: { heart_rate: 0 },
    });
    expect(danielStatus.json()).toMatchObject({
      counts: { heart_rate: 1 },
    });
    expect(mqttPublisher.batches[0]?.context.name).toBe("daniel");
    expect(mqttPublisher.normalizedBatches[0]?.context.name).toBe("daniel");
    expect(mqttPublisher.currentBatches[0]?.context.name).toBe("daniel");
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
    expect(status.json()).toMatchObject({
      counts: {
        heart_rate: 0,
      },
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
});
