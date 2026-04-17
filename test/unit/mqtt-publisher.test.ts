import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  createMqttPublisherFromClient,
  type MqttPublishClient,
} from "../../src/mqtt/publisher.js";

interface PublishCall {
  topic: string;
  message: string | Buffer;
  options?: { qos?: 0 | 1 | 2; retain?: boolean };
}

function createRecordingClient(): MqttPublishClient & {
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

describe("MQTT publisher", () => {
  it("publishes one raw event per sample", async () => {
    const client = createRecordingClient();
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_ENABLED: "false",
      MQTT_URL: "mqtt://localhost:1883",
      MQTT_QOS: "1",
      MQTT_RETAIN: "false",
    });
    const publisher = createMqttPublisherFromClient(client, config);

    const result = await publisher.publishRawBatch(config.contexts[0]!, {
      metric: "step_count",
      batch_index: 2,
      total_batches: 4,
      samples: [
        { qty: 120, source: "Watch", date: "2026-04-10T12:00:00Z" },
        { qty: 121, source: "Watch", date: "2026-04-10T12:01:00Z" },
      ],
    });

    expect(result).toEqual({
      topic: "healthsave/raw/step_count",
      records: 2,
    });
    expect(client.publishCalls).toHaveLength(2);
    expect(client.publishCalls[0]?.topic).toBe("healthsave/raw/step_count");
    expect(client.publishCalls[0]?.options).toEqual({ qos: 1, retain: false });

    const firstPayload = JSON.parse(
      client.publishCalls[0]?.message.toString() ?? "{}",
    ) as Record<string, unknown>;
    expect(firstPayload).toMatchObject({
      metric: "step_count",
      event_type: "raw_sample",
      batch_index: 2,
      total_batches: 4,
      device_id: "Watch",
      sample_index: 0,
      sample: { qty: 120, source: "Watch", date: "2026-04-10T12:00:00Z" },
    });
    expect(firstPayload.ingested_at).toEqual(expect.any(String));
    expect(firstPayload.idempotency_key).toEqual(
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });

  it("publishes normalized datapoints to logical topics", async () => {
    const client = createRecordingClient();
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_ENABLED: "false",
      MQTT_URL: "mqtt://localhost:1883",
      MQTT_TOPIC_NORMALIZED: "healthsave/normalized/{metric}",
    });
    const publisher = createMqttPublisherFromClient(client, config);

    const result = await publisher.publishNormalizedBatch(
      config.contexts[0]!,
      {
        metric: "heart_rate_variability",
        batch_index: 1,
        total_batches: 2,
        samples: [],
      },
      [
        {
          metric: "heart_rate_variability",
          normalizedMetric: "hrv",
          recordIndex: 0,
          deviceId: "Watch",
          normalizedSample: {
            time: "2026-04-10T12:00:00.000Z",
            value_ms: 44,
            algorithm: "sdnn",
          },
        },
      ],
    );

    expect(result).toEqual({
      records: 1,
      topics: ["healthsave/normalized/hrv"],
    });
    expect(client.publishCalls[0]?.topic).toBe("healthsave/normalized/hrv");

    const payload = JSON.parse(
      client.publishCalls[0]?.message.toString() ?? "{}",
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      metric: "heart_rate_variability",
      normalized_metric: "hrv",
      event_type: "normalized_sample",
      batch_index: 1,
      total_batches: 2,
      device_id: "Watch",
      record_index: 0,
      normalized_sample: {
        time: "2026-04-10T12:00:00.000Z",
        value_ms: 44,
        algorithm: "sdnn",
      },
    });
    expect(payload.idempotency_key).toEqual(
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });

  it("uses sample-level metric names for quantity sample topics", async () => {
    const client = createRecordingClient();
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_ENABLED: "false",
      MQTT_URL: "mqtt://localhost:1883",
      MQTT_TOPIC_NORMALIZED: "healthsave/normalized/{metric}",
      MQTT_TOPIC_CURRENT: "healthsave/current/{metric}",
    });
    const publisher = createMqttPublisherFromClient(client, config);

    const normalizedResult = await publisher.publishNormalizedBatch(
      config.contexts[0]!,
      {
        metric: "blood_pressure",
        batch_index: 1,
        total_batches: 1,
        samples: [],
      },
      [
        {
          metric: "blood_pressure",
          normalizedMetric: "quantity_samples",
          recordIndex: 0,
          deviceId: "Monitor",
          normalizedSample: {
            time: "2026-04-10T09:00:00.000Z",
            metric_name: "blood_pressure_systolic",
            value: 120,
            unit: "mmHg",
          },
        },
      ],
    );

    expect(normalizedResult).toEqual({
      records: 1,
      topics: ["healthsave/normalized/blood_pressure_systolic"],
    });
    expect(client.publishCalls[0]?.topic).toBe(
      "healthsave/normalized/blood_pressure_systolic",
    );

    client.publishCalls = [];

    const currentResult = await publisher.publishCurrentBatch(config.contexts[0]!, [
      {
        metric: "blood_pressure",
        normalizedMetric: "quantity_samples",
        recordIndex: 0,
        deviceId: "Monitor",
        normalizedSample: {
          time: "2026-04-10T09:00:00.000Z",
          metric_name: "blood_pressure_systolic",
          value: 120,
          unit: "mmHg",
        },
      },
    ]);

    expect(currentResult).toEqual({
      records: 1,
      topics: ["healthsave/current/blood_pressure_systolic"],
    });
    expect(client.publishCalls).toMatchObject([
      {
        topic: "healthsave/current/blood_pressure_systolic",
        message: "120",
      },
    ]);
  });

  it("publishes current scalar values to logical topics", async () => {
    const client = createRecordingClient();
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_ENABLED: "false",
      MQTT_URL: "mqtt://localhost:1883",
      MQTT_TOPIC_CURRENT: "healthsave/current/{metric}",
    });
    const publisher = createMqttPublisherFromClient(client, config);

    const result = await publisher.publishCurrentBatch(config.contexts[0]!, [
      {
        metric: "heart_rate",
        normalizedMetric: "heart_rate",
        recordIndex: 0,
        deviceId: "Watch",
        normalizedSample: {
          time: "2026-04-10T12:00:00.000Z",
          bpm: 67,
          source_id: "Watch",
        },
      },
      {
        metric: "walking_speed",
        normalizedMetric: "quantity_samples",
        recordIndex: 1,
        deviceId: "Phone",
        normalizedSample: {
          time: "2026-04-10T12:00:00.000Z",
          metric_name: "walking_speed",
          value: 1.2,
        },
      },
      {
        metric: "blood_oxygen",
        normalizedMetric: "blood_oxygen",
        recordIndex: 2,
        deviceId: "Watch",
        normalizedSample: {
          time: "2026-04-10T12:05:00.000Z",
          spo2_pct: 97.3,
        },
      },
    ]);

    expect(result).toEqual({
      records: 3,
      topics: [
        "healthsave/current/heart_rate",
        "healthsave/current/walking_speed",
        "healthsave/current/blood_oxygen",
      ],
    });
    expect(client.publishCalls).toMatchObject([
      {
        topic: "healthsave/current/heart_rate",
        message: "67",
      },
      {
        topic: "healthsave/current/walking_speed",
        message: "1.2",
      },
      {
        topic: "healthsave/current/blood_oxygen",
        message: "97.3",
      },
    ]);
  });

  it("publishes multi-field current values to subtopics", async () => {
    const client = createRecordingClient();
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_ENABLED: "false",
      MQTT_URL: "mqtt://localhost:1883",
      MQTT_TOPIC_CURRENT: "healthsave/current/{metric}",
    });
    const publisher = createMqttPublisherFromClient(client, config);

    const result = await publisher.publishCurrentBatch(config.contexts[0]!, [
      {
        metric: "step_count",
        normalizedMetric: "daily_activity",
        recordIndex: 0,
        deviceId: "Phone",
        normalizedSample: {
          date: "2026-04-10",
          steps: 1000,
          active_calories: 450,
          stand_hours: 10,
        },
      },
      {
        metric: "sleep_analysis",
        normalizedMetric: "sleep_sessions",
        recordIndex: 1,
        deviceId: "Watch",
        normalizedSample: {
          start_time: "2026-04-10T22:00:00.000Z",
          end_time: "2026-04-11T06:00:00.000Z",
          awake: true,
          total_duration_ms: 28800000,
          deep_ms: 7200000,
          rem_ms: 3600000,
          light_ms: 18000000,
          awake_ms: 0,
        },
      },
      {
        metric: "workouts",
        normalizedMetric: "workouts",
        recordIndex: 2,
        deviceId: "Runkeeper",
        normalizedSample: {
          start_time: "2016-01-20T13:59:13.337Z",
          end_time: "2016-01-20T14:42:29.337Z",
          calories: 366.3367462222223,
          duration_ms: 2596000,
          avg_hr: 144,
          max_hr: 168,
          distance_m: 10000,
        },
      },
    ]);

    expect(result).toEqual({
      records: 16,
      topics: [
        "healthsave/current/daily_activity/steps",
        "healthsave/current/daily_activity/active_calories",
        "healthsave/current/daily_activity/stand_hours",
        "healthsave/current/sleep_sessions",
        "healthsave/current/sleep_sessions/awake",
        "healthsave/current/sleep_sessions/total_duration_ms",
        "healthsave/current/sleep_sessions/deep_ms",
        "healthsave/current/sleep_sessions/rem_ms",
        "healthsave/current/sleep_sessions/light_ms",
        "healthsave/current/sleep_sessions/awake_ms",
        "healthsave/current/workouts",
        "healthsave/current/workouts/calories",
        "healthsave/current/workouts/duration_ms",
        "healthsave/current/workouts/avg_hr",
        "healthsave/current/workouts/max_hr",
        "healthsave/current/workouts/distance_m",
      ],
    });
    expect(client.publishCalls).toMatchObject([
      {
        topic: "healthsave/current/daily_activity/steps",
        message: "1000",
      },
      {
        topic: "healthsave/current/daily_activity/active_calories",
        message: "450",
      },
      {
        topic: "healthsave/current/daily_activity/stand_hours",
        message: "10",
      },
      {
        topic: "healthsave/current/sleep_sessions",
        message: "true",
      },
      {
        topic: "healthsave/current/sleep_sessions/awake",
        message: "true",
      },
      {
        topic: "healthsave/current/sleep_sessions/total_duration_ms",
        message: "28800000",
      },
      {
        topic: "healthsave/current/sleep_sessions/deep_ms",
        message: "7200000",
      },
      {
        topic: "healthsave/current/sleep_sessions/rem_ms",
        message: "3600000",
      },
      {
        topic: "healthsave/current/sleep_sessions/light_ms",
        message: "18000000",
      },
      {
        topic: "healthsave/current/sleep_sessions/awake_ms",
        message: "0",
      },
      {
        topic: "healthsave/current/workouts",
        message: "366.3367462222223",
      },
      {
        topic: "healthsave/current/workouts/calories",
        message: "366.3367462222223",
      },
      {
        topic: "healthsave/current/workouts/duration_ms",
        message: "2596000",
      },
      {
        topic: "healthsave/current/workouts/avg_hr",
        message: "144",
      },
      {
        topic: "healthsave/current/workouts/max_hr",
        message: "168",
      },
      {
        topic: "healthsave/current/workouts/distance_m",
        message: "10000",
      },
    ]);
  });

  it("uses context topic templates", async () => {
    const client = createRecordingClient();
    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_ENABLED: "false",
      MQTT_URL: "mqtt://localhost:1883",
      CONTEXTS: JSON.stringify([
        {
          name: "daniel",
          prefix: "/daniel",
          topics: {
            raw: "healthsave/{context}/raw/{metric}",
            normalized: "healthsave/{context}/normalized/{metric}",
            current: "healthsave/{context}/current/{metric}",
          },
        },
      ]),
    });
    const publisher = createMqttPublisherFromClient(client, config);
    const context = config.contexts.find((item) => item.name === "daniel")!;

    await publisher.publishCurrentBatch(context, [
      {
        metric: "heart_rate",
        normalizedMetric: "heart_rate",
        recordIndex: 0,
        deviceId: "Watch",
        normalizedSample: {
          time: "2026-04-10T12:00:00.000Z",
          bpm: 67,
        },
      },
    ]);

    expect(client.publishCalls[0]?.topic).toBe(
      "healthsave/daniel/current/heart_rate",
    );
  });
});
