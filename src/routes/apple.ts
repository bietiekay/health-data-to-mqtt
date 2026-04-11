import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestApiKey, isAuthorized } from "../auth.js";
import type { AppConfig, AppContextConfig } from "../config.js";
import {
  batchRequestSchema,
  createStatusObservations,
  normalizeBatch,
} from "../ingest.js";
import type { HealthMqttPublisher } from "../mqtt/publisher.js";
import type { StateStore } from "../state/store.js";
import type { RawBatchStorage } from "../storage/raw-batch-storage.js";

interface AppleRouteOptions {
  config: AppConfig;
  context: AppContextConfig;
  stateStore: StateStore;
  mqttPublisher: HealthMqttPublisher;
  rawBatchStorage: RawBatchStorage;
}

function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): boolean {
  if (isAuthorized(config, getRequestApiKey(request))) {
    return true;
  }

  reply.code(401).send({ detail: "Invalid API key" });
  return false;
}

export async function registerAppleRoutes(
  app: FastifyInstance,
  options: AppleRouteOptions,
): Promise<void> {
  app.post("/api/apple/batch", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    request.log.debug(
      { body_keys: getObjectKeys(request.body) },
      "received apple health batch request body",
    );
    request.log.trace(
      { body: request.body },
      "received raw apple health batch request body",
    );

    const rawBody = request.body;
    const parsed = batchRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return reply.code(400).send({
        status: "error",
        error: "Invalid batch payload",
        details: parsed.error.flatten(),
      });
    }

    const batch = parsed.data;
    const rawRecords = batch.samples.length;
    const normalizedRecords = normalizeBatch(batch);
    const processedRecords = normalizedRecords.length;
    const statusObservations = createStatusObservations(normalizedRecords);
    request.log.debug(
      {
        context: options.context.name,
        prefix: options.context.prefix,
        metric: batch.metric,
        batch_index: batch.batch_index,
        total_batches: batch.total_batches,
        raw_records: rawRecords,
        processed_records: processedRecords,
        status_observations: statusObservations.length,
        first_sample_keys: getFirstSampleKeys(batch.samples),
        mqtt_enabled: options.config.mqtt.enabled,
      },
      "received apple health batch",
    );

    if (batch.samples.length === 0) {
      return {
        status: "empty",
        metric: batch.metric,
        batch: batch.batch_index,
        records: 0,
      };
    }

    try {
      await options.rawBatchStorage.storeBatch(
        options.context,
        batch,
        rawBody,
      );
    } catch (error) {
      request.log.error(
        {
          err: error,
          context: options.context.name,
          metric: batch.metric,
          batch_index: batch.batch_index,
          total_batches: batch.total_batches,
          raw_records: rawRecords,
        },
        "failed to store raw apple health batch",
      );

      return reply.code(500).send({
        status: "error",
        error: "Failed to store raw batch",
      });
    }

    try {
      const rawPublishResult = await options.mqttPublisher.publishRawBatch(
        options.context,
        batch,
      );
      const normalizedPublishResult =
        await options.mqttPublisher.publishNormalizedBatch(
          options.context,
          batch,
          normalizedRecords,
        );
      const currentPublishResult =
        await options.mqttPublisher.publishCurrentBatch(
          options.context,
          normalizedRecords,
        );
      request.log.debug(
        {
          context: options.context.name,
          metric: batch.metric,
          raw_topic: rawPublishResult.topic,
          normalized_topics: normalizedPublishResult.topics,
          current_topics: currentPublishResult.topics,
          raw_records: rawRecords,
          processed_records: processedRecords,
          raw_published_records: rawPublishResult.records,
          normalized_published_records: normalizedPublishResult.records,
          current_published_records: currentPublishResult.records,
        },
        "published apple health batch to mqtt",
      );
    } catch (error) {
      request.log.error(
        {
          err: error,
          context: options.context.name,
          metric: batch.metric,
          batch_index: batch.batch_index,
          total_batches: batch.total_batches,
          raw_records: rawRecords,
          processed_records: processedRecords,
        },
        "failed to publish apple health batch to mqtt",
      );

      return reply.code(502).send({
        status: "error",
        error: "Failed to publish batch to MQTT",
      });
    }

    const statusUpdate = await options.stateStore.applyObservations(
      statusObservations,
      options.context.name,
    );
    request.log.debug(
      {
        context: options.context.name,
        metric: batch.metric,
        processed_records: processedRecords,
        applied_status_observations: statusUpdate.applied,
        duplicate_status_observations: statusUpdate.duplicates,
      },
      "updated apple health status ledger",
    );

    return {
      status: "processed",
      metric: batch.metric,
      batch: batch.batch_index,
      total_batches: batch.total_batches,
      records: processedRecords,
    };
  });

  app.get("/api/apple/status", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const status = await options.stateStore.getStatus(options.context.name);
    request.log.debug(
      {
        context: options.context.name,
        status,
      },
      "returned apple health status snapshot",
    );

    return status;
  });
}

function getFirstSampleKeys(samples: Array<Record<string, unknown>>): string[] {
  const [firstSample] = samples;
  return firstSample ? Object.keys(firstSample).sort() : [];
}

function getObjectKeys(value: unknown): string[] {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return [];
  }

  return Object.keys(value).sort();
}
