import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";
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
  type SyncReceiptHeaders,
  type SyncReceiptStore,
} from "../state/sync-receipts.js";
import { createEmptyStatus, type StateStore } from "../state/store.js";
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
      return reply.code(422).send({ detail: toValidationErrors(parsed.error) });
    }

    const batch = parsed.data;
    const sampleWindow = sampleWindowFromRequest(request.headers, batch.samples);
    const receiptHeaders = withDerivedReceiptFields(
      parseSyncReceiptHeaders(request.headers),
      batch.metric,
      batch.batch_index,
      sampleWindow,
    );
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
        if (
          receiptHeaders.payloadHash &&
          existingReceipt.payload_hash &&
          existingReceipt.payload_hash !== receiptHeaders.payloadHash
        ) {
          return reply.code(409).send(idempotencyConflictResponse());
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
      const response = createBatchResponse({
        status: "empty",
        batch,
        receiptHeaders,
        sampleWindow,
        recordsReceived: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        recordsDedupedInBatch: null,
      });

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
      "updated apple health status store",
    );

    const response = createBatchResponse({
      status: "processed",
      batch,
      receiptHeaders,
      sampleWindow,
      recordsReceived: normalizationResult.stats.recordsReceived,
      recordsAccepted: normalizationResult.stats.recordsAccepted,
      recordsRejected: normalizationResult.stats.recordsRejected,
      recordsDedupedInBatch: normalizationResult.stats.recordsDedupedInBatch,
    });

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

    let status;
    try {
      status = await options.stateStore.getStatus(options.context.name);
    } catch (error) {
      request.log.error(
        { err: error, context: options.context.name },
        "failed to load apple health status snapshot",
      );
      status = createEmptyStatus();
    }
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

function withDerivedReceiptFields(
  headers: SyncReceiptHeaders,
  metric: string,
  batchIndex: number,
  sampleWindow: SampleWindow,
): SyncReceiptHeaders {
  const idempotencyKey =
    headers.idempotencyKey ??
    headers.batchId ??
    (headers.syncRunId ? `${headers.syncRunId}:${metric}:${batchIndex}` : undefined);

  return {
    ...headers,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(sampleWindow.min_sample_time
      ? { sampleMinTime: sampleWindow.min_sample_time }
      : {}),
    ...(sampleWindow.max_sample_time
      ? { sampleMaxTime: sampleWindow.max_sample_time }
      : {}),
  };
}

interface SampleWindow {
  min_sample_time: string | null;
  max_sample_time: string | null;
}

interface CreateBatchResponseInput {
  status: "processed" | "empty";
  batch: {
    metric: string;
    batch_index: number;
    total_batches: number;
  };
  receiptHeaders: SyncReceiptHeaders;
  sampleWindow: SampleWindow;
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
  recordsDedupedInBatch: number | null;
}

function createBatchResponse(input: CreateBatchResponseInput): BatchResponseBody {
  const receiptId =
    input.receiptHeaders.idempotencyKey ??
    input.receiptHeaders.batchId ??
    `${input.receiptHeaders.syncRunId ?? "runless"}:${input.batch.metric}:${input.batch.batch_index}`;
  const perMetric = {
    [input.batch.metric]: {
      received: input.recordsReceived,
      accepted: input.recordsAccepted,
      rejected: input.recordsRejected,
      inserted_new: null,
      deduped_existing: null,
      deduped_in_batch: input.recordsDedupedInBatch,
      sample_window: input.sampleWindow,
    },
  };

  return {
    status: input.status,
    metric: input.batch.metric,
    batch: input.batch.batch_index,
    total_batches: input.batch.total_batches,
    records: input.recordsAccepted,
    receipt_id: receiptId,
    sync_run_id: input.receiptHeaders.syncRunId ?? null,
    batch_id: input.receiptHeaders.batchId ?? null,
    idempotency_key: input.receiptHeaders.idempotencyKey ?? null,
    batch_index: input.batch.batch_index,
    records_received: input.recordsReceived,
    records_accepted: input.recordsAccepted,
    records_rejected: input.recordsRejected,
    records_inserted_new: null,
    records_deduped_existing: null,
    records_deduped_in_batch: input.recordsDedupedInBatch,
    storage_result_level: "accepted_only",
    sample_window: input.sampleWindow,
    verification_level: "delivery_receipt",
    per_metric: perMetric,
  };
}

function idempotencyConflictResponse() {
  return {
    detail: {
      status: "rejected",
      error_code: "idempotency_key_payload_mismatch",
      message:
        "This idempotency key was already received with a different payload hash.",
    },
  };
}

function sampleWindowFromRequest(
  headers: IncomingHttpHeaders,
  samples: Array<Record<string, unknown>>,
): SampleWindow {
  const headerMin = headerString(headers["x-healthsave-sample-min-time"]);
  const headerMax = headerString(headers["x-healthsave-sample-max-time"]);
  if (headerMin !== undefined || headerMax !== undefined) {
    return {
      min_sample_time: formatHeaderTimestamp(headerMin),
      max_sample_time: formatHeaderTimestamp(headerMax),
    };
  }

  return sampleWindowFromSamples(samples);
}

function sampleWindowFromSamples(samples: Array<Record<string, unknown>>): SampleWindow {
  const starts: Array<{ date: Date; text: string }> = [];
  const ends: Array<{ date: Date; text: string }> = [];

  for (const sample of samples) {
    const start = firstParseableSampleTime(
      sample,
      "date",
      "startDate",
      "start_date",
      "start",
      "start_time",
      "time",
    );
    if (start) {
      starts.push(start);
    }

    const end = firstParseableSampleTime(
      sample,
      "endDate",
      "end_date",
      "end",
      "end_time",
      "date",
      "time",
    );
    if (end) {
      ends.push(end);
    }
  }

  return {
    min_sample_time: minParsedTime(starts)?.text ?? null,
    max_sample_time: maxParsedTime(ends)?.text ?? null,
  };
}

function firstParseableSampleTime(
  sample: Record<string, unknown>,
  ...keys: string[]
): { date: Date; text: string } | undefined {
  for (const key of keys) {
    const parsed = parseSampleTime(sample[key]);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parseSampleTime(value: unknown): { date: Date; text: string } | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const text = value.trim();
  const timestamp = Date.parse(text.replace(/Z$/, "+00:00"));
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return {
    date: new Date(timestamp),
    text,
  };
}

function formatHeaderTimestamp(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const parsed = parseSampleTime(value);
  if (!parsed) {
    return null;
  }

  return parsed.date.toISOString().replace(".000Z", "Z");
}

function minParsedTime(
  values: Array<{ date: Date; text: string }>,
): { date: Date; text: string } | undefined {
  return values.reduce<typeof values[number] | undefined>(
    (minimum, value) =>
      !minimum || value.date.getTime() < minimum.date.getTime()
        ? value
        : minimum,
    undefined,
  );
}

function maxParsedTime(
  values: Array<{ date: Date; text: string }>,
): { date: Date; text: string } | undefined {
  return values.reduce<typeof values[number] | undefined>(
    (maximum, value) =>
      !maximum || value.date.getTime() > maximum.date.getTime()
        ? value
        : maximum,
    undefined,
  );
}

function headerString(value: string | string[] | undefined): string | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const trimmed = rawValue?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function toValidationErrors(error: ZodError): Array<Record<string, unknown>> {
  return error.issues.map((issue) => ({
    type: issue.code,
    loc: ["body", ...issue.path],
    msg: issue.message,
  }));
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
