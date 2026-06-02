import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireApiKey } from "../auth.js";
import type { AppConfig, AppContextConfig } from "../config.js";
import {
  batchRequestSchema,
  createStatusObservations,
  normalizeBatchWithStats,
} from "../ingest.js";
import type { HealthMqttPublisher } from "../mqtt/publisher.js";
import type { IdempotencyStore } from "../state/idempotency-store.js";
import {
  parseSyncReceiptHeaders,
  type BatchResponseBody,
  type SyncReceiptStore,
} from "../state/sync-receipts.js";
import type { StateStore } from "../state/store.js";
import type { RawBatchStorage } from "../storage/raw-batch-storage.js";

interface AppleRouteOptions {
  config: AppConfig;
  context: AppContextConfig;
  stateStore: StateStore;
  mqttPublisher: HealthMqttPublisher;
  rawBatchStorage: RawBatchStorage;
  syncReceiptStore: SyncReceiptStore;
  idempotencyStore: IdempotencyStore;
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
    const receiptHeaders = parseSyncReceiptHeaders(request.headers);
    if (receiptHeaders.idempotencyKey) {
      const existingReceipt =
        (await options.idempotencyStore.getEntry(
          options.context.name,
          receiptHeaders.idempotencyKey,
        )) ??
        (await options.syncReceiptStore.getIdempotencyReceipt(
          options.context.name,
          receiptHeaders.idempotencyKey,
        ));
      if (existingReceipt) {
        if (existingReceipt.payload_hash !== receiptHeaders.payloadHash) {
          return reply.code(409).send({
            status: "error",
            error: "Idempotency key was already used with a different payload hash",
          });
        }

        request.log.debug(
          {
            context: options.context.name,
            metric: batch.metric,
            idempotency_key: receiptHeaders.idempotencyKey,
          },
          "replayed apple health batch response from sync receipt",
        );
        return existingReceipt.response;
      }
    }

    const rawRecords = batch.samples.length;
    const normalizationResult = normalizeBatchWithStats(batch);
    const normalizedRecords = normalizationResult.records;
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
      const response: BatchResponseBody = {
        status: "empty",
        metric: batch.metric,
        batch: batch.batch_index,
        records: 0,
      };

      await options.syncReceiptStore.recordBatch({
        contextName: options.context.name,
        headers: receiptHeaders,
        metric: batch.metric,
        batchIndex: batch.batch_index,
        totalBatches: batch.total_batches,
        recordsReceived: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        recordsDedupedInBatch: 0,
        response,
      });
      await recordIdempotencySuccess(request, options, receiptHeaders, response);

      return response;
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

      await options.syncReceiptStore.recordFailedBatch({
        contextName: options.context.name,
        headers: receiptHeaders,
        metric: batch.metric,
        batchIndex: batch.batch_index,
        totalBatches: batch.total_batches,
        recordsReceived: rawRecords,
        failureStatusCode: 500,
        failureReason: "Failed to store raw batch",
      });

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

      await options.syncReceiptStore.recordFailedBatch({
        contextName: options.context.name,
        headers: receiptHeaders,
        metric: batch.metric,
        batchIndex: batch.batch_index,
        totalBatches: batch.total_batches,
        recordsReceived: normalizationResult.stats.recordsReceived,
        failureStatusCode: 502,
        failureReason: "Failed to publish batch to MQTT",
      });

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

    const response: BatchResponseBody = {
      status: "processed",
      metric: batch.metric,
      batch: batch.batch_index,
      total_batches: batch.total_batches,
      records: processedRecords,
    };

    await options.syncReceiptStore.recordBatch({
      contextName: options.context.name,
      headers: receiptHeaders,
      metric: batch.metric,
      batchIndex: batch.batch_index,
      totalBatches: batch.total_batches,
      recordsReceived: normalizationResult.stats.recordsReceived,
      recordsAccepted: normalizationResult.stats.recordsAccepted,
      recordsRejected: normalizationResult.stats.recordsRejected,
      recordsDedupedInBatch: normalizationResult.stats.recordsDedupedInBatch,
      latestDestinationSampleTime:
        latestDestinationSampleTime(statusObservations),
      response,
    });
    await recordIdempotencySuccess(request, options, receiptHeaders, response);

    return response;
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

async function recordIdempotencySuccess(
  request: FastifyRequest,
  options: AppleRouteOptions,
  receiptHeaders: { idempotencyKey?: string; payloadHash?: string },
  response: BatchResponseBody,
): Promise<void> {
  if (!receiptHeaders.idempotencyKey) {
    return;
  }

  try {
    await options.idempotencyStore.recordSuccess({
      contextName: options.context.name,
      idempotencyKey: receiptHeaders.idempotencyKey,
      payloadHash: receiptHeaders.payloadHash,
      response,
    });
  } catch (error) {
    request.log.error(
      {
        err: error,
        context: options.context.name,
        metric: response.metric,
        batch: response.batch,
      },
      "failed to record apple health idempotency key after batch acceptance",
    );
  }
}

function latestDestinationSampleTime(
  observations: Array<{ observedAt: string }>,
): string | undefined {
  return observations
    .map((observation) => observation.observedAt)
    .sort()
    .at(-1);
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
