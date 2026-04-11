import { createHash } from "node:crypto";
import { connectAsync, type IClientOptions } from "mqtt";
import type { AppConfig, AppContextConfig } from "../config.js";
import type { BatchRequest, NormalizedRecord } from "../ingest.js";
import { resolveDeviceIdentity } from "../ingest.js";
import { renderMetricTopic } from "./topics.js";

type MqttQos = 0 | 1 | 2;

export interface MqttPublishClient {
  publishAsync(
    topic: string,
    message: string | Buffer,
    options?: { qos?: MqttQos; retain?: boolean },
  ): Promise<unknown>;
  endAsync(force?: boolean): Promise<void>;
}

export interface RawPublishResult {
  topic: string;
  records: number;
}

export interface NormalizedPublishResult {
  records: number;
  topics: string[];
}

export interface CurrentPublishResult {
  records: number;
  topics: string[];
}

export interface HealthMqttPublisher {
  publishRawBatch(
    context: AppContextConfig,
    batch: BatchRequest,
  ): Promise<RawPublishResult>;
  publishNormalizedBatch(
    context: AppContextConfig,
    batch: BatchRequest,
    records: NormalizedRecord[],
  ): Promise<NormalizedPublishResult>;
  publishCurrentBatch(
    context: AppContextConfig,
    records: NormalizedRecord[],
  ): Promise<CurrentPublishResult>;
  close(): Promise<void>;
}

interface RawSampleEvent {
  metric: string;
  event_type: "raw_sample";
  ingested_at: string;
  batch_index: number;
  total_batches: number;
  device_id: string;
  sample_index: number;
  sample: Record<string, unknown>;
  idempotency_key: string;
}

interface NormalizedSampleEvent {
  metric: string;
  normalized_metric: string;
  event_type: "normalized_sample";
  ingested_at: string;
  batch_index: number;
  total_batches: number;
  device_id: string;
  record_index: number;
  normalized_sample: Record<string, unknown>;
  idempotency_key: string;
}

export function createNoopMqttPublisher(): HealthMqttPublisher {
  return {
    async publishRawBatch(context, batch) {
      return {
        topic: renderMetricTopic("disabled", batch.metric, context.name),
        records: 0,
      };
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
  };
}

export async function createMqttPublisher(
  config: AppConfig,
): Promise<HealthMqttPublisher> {
  if (!config.mqtt.enabled) {
    return createNoopMqttPublisher();
  }

  const client = await connectAsync(
    config.mqtt.url,
    {
      clientId: config.mqtt.clientId,
      username: config.mqtt.username,
      password: config.mqtt.password,
      reconnectPeriod: 1_000,
      connectTimeout: 5_000,
    } satisfies IClientOptions,
    false,
  );

  return new MqttHealthPublisher(client, config);
}

export function createMqttPublisherFromClient(
  client: MqttPublishClient,
  config: AppConfig,
): HealthMqttPublisher {
  return new MqttHealthPublisher(client, config);
}

class MqttHealthPublisher implements HealthMqttPublisher {
  constructor(
    private readonly client: MqttPublishClient,
    private readonly config: AppConfig,
  ) {}

  async publishRawBatch(
    context: AppContextConfig,
    batch: BatchRequest,
  ): Promise<RawPublishResult> {
    const topic = renderMetricTopic(
      context.mqtt.topics.raw,
      batch.metric,
      context.name,
    );
    const ingestedAt = new Date().toISOString();
    const publishOptions = {
      qos: toMqttQos(this.config.mqtt.qos),
      retain: this.config.mqtt.retain,
    };

    await Promise.all(
      batch.samples.map((sample, sampleIndex) => {
        const event = createRawSampleEvent(
          batch,
          sample,
          sampleIndex,
          ingestedAt,
        );

        return this.client.publishAsync(
          topic,
          JSON.stringify(event),
          publishOptions,
        );
      }),
    );

    return {
      topic,
      records: batch.samples.length,
    };
  }

  async publishNormalizedBatch(
    context: AppContextConfig,
    batch: BatchRequest,
    records: NormalizedRecord[],
  ): Promise<NormalizedPublishResult> {
    const ingestedAt = new Date().toISOString();
    const topics = new Set<string>();
    const publishOptions = {
      qos: toMqttQos(this.config.mqtt.qos),
      retain: this.config.mqtt.retain,
    };

    await Promise.all(
      records.map((record) => {
        const topic = renderMetricTopic(
          context.mqtt.topics.normalized,
          topicMetricForRecord(record),
          context.name,
        );
        topics.add(topic);

        return this.client.publishAsync(
          topic,
          JSON.stringify(createNormalizedSampleEvent(batch, record, ingestedAt)),
          publishOptions,
        );
      }),
    );

    return {
      records: records.length,
      topics: [...topics],
    };
  }

  async publishCurrentBatch(
    context: AppContextConfig,
    records: NormalizedRecord[],
  ): Promise<CurrentPublishResult> {
    const topics = new Set<string>();
    const publishOptions = {
      qos: toMqttQos(this.config.mqtt.qos),
      retain: this.config.mqtt.retain,
    };
    const currentMessages = records.flatMap((record) => {
      const value = currentValueForRecord(record);
      if (value === undefined) {
        return [];
      }

      const topic = renderMetricTopic(
        context.mqtt.topics.current,
        topicMetricForRecord(record),
        context.name,
      );
      topics.add(topic);

      return [{ topic, value }];
    });

    await Promise.all(
      currentMessages.map((message) =>
        this.client.publishAsync(
          message.topic,
          String(message.value),
          publishOptions,
        ),
      ),
    );

    return {
      records: currentMessages.length,
      topics: [...topics],
    };
  }

  async close(): Promise<void> {
    await this.client.endAsync(false);
  }
}

function createRawSampleEvent(
  batch: BatchRequest,
  sample: Record<string, unknown>,
  sampleIndex: number,
  ingestedAt: string,
): RawSampleEvent {
  return {
    metric: batch.metric,
    event_type: "raw_sample",
    ingested_at: ingestedAt,
    batch_index: batch.batch_index,
    total_batches: batch.total_batches,
    device_id: getDeviceId(sample),
    sample_index: sampleIndex,
    sample,
    idempotency_key: createIdempotencyKey(batch, sample, sampleIndex),
  };
}

function createNormalizedSampleEvent(
  batch: BatchRequest,
  record: NormalizedRecord,
  ingestedAt: string,
): NormalizedSampleEvent {
  return {
    metric: record.metric,
    normalized_metric: record.normalizedMetric,
    event_type: "normalized_sample",
    ingested_at: ingestedAt,
    batch_index: batch.batch_index,
    total_batches: batch.total_batches,
    device_id: record.deviceId,
    record_index: record.recordIndex,
    normalized_sample: record.normalizedSample,
    idempotency_key: createNormalizedIdempotencyKey(batch, record),
  };
}

function getDeviceId(sample: Record<string, unknown>): string {
  return resolveDeviceIdentity(sample);
}

function createIdempotencyKey(
  batch: BatchRequest,
  sample: Record<string, unknown>,
  sampleIndex: number,
): string {
  const source = stableJson({
    metric: batch.metric,
    batch_index: batch.batch_index,
    total_batches: batch.total_batches,
    sample_index: sampleIndex,
    sample,
  });

  return createHash("sha256").update(source).digest("hex");
}

function createNormalizedIdempotencyKey(
  batch: BatchRequest,
  record: NormalizedRecord,
): string {
  const source = stableJson({
    metric: batch.metric,
    batch_index: batch.batch_index,
    total_batches: batch.total_batches,
    normalized_metric: record.normalizedMetric,
    record_index: record.recordIndex,
    device_id: record.deviceId,
    normalized_sample: record.normalizedSample,
  });

  return createHash("sha256").update(source).digest("hex");
}

function topicMetricForRecord(record: NormalizedRecord): string {
  return record.normalizedMetric === "quantity_samples"
    ? record.metric
    : record.normalizedMetric;
}

const currentValueFields: Record<string, string> = {
  heart_rate: "bpm",
  hrv: "value_ms",
  blood_oxygen: "spo2_pct",
  body_temperature: "temp_celsius",
  sleep_sessions: "awake",
  workouts: "calories",
  quantity_samples: "value",
};

function currentValueForRecord(record: NormalizedRecord): unknown {
  const valueField = currentValueFields[record.normalizedMetric];
  if (!valueField) {
    return undefined;
  }

  const value = record.normalizedSample[valueField];
  return value === null ? undefined : value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function toMqttQos(qos: number): MqttQos {
  if (qos === 0 || qos === 1 || qos === 2) {
    return qos;
  }

  throw new Error(`Unsupported MQTT QoS value: ${qos}`);
}
