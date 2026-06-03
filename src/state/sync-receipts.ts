import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { AppConfig } from "../config.js";
import { parseTimestamp } from "../ingest.js";
import { encodeContextName } from "../storage/raw-batch-storage.js";

export interface SyncReceiptHeaders {
  idempotencyKey?: string;
  syncRunId?: string;
  batchId?: string;
  payloadHash?: string;
  metric?: string;
  batchIndex?: string;
  totalBatches?: string;
  syncMode?: string;
  anchorPresent?: string;
  lowerBoundReason?: string;
  fullExport?: string;
  queryLowerBound?: string;
  sampleMinTime?: string;
  sampleMaxTime?: string;
}

export interface BatchResponseBody {
  status: "processed" | "empty";
  metric: string;
  batch: number;
  total_batches: number;
  records: number;
  receipt_id: string;
  sync_run_id: string | null;
  batch_id: string | null;
  idempotency_key: string | null;
  batch_index: number;
  records_received: number;
  records_accepted: number;
  records_rejected: number;
  records_inserted_new: null;
  records_deduped_existing: null;
  records_deduped_in_batch: number | null;
  storage_result_level: "accepted_only";
  sample_window: {
    min_sample_time: string | null;
    max_sample_time: string | null;
  };
  verification_level: "delivery_receipt";
  per_metric: Record<
    string,
    {
      received: number;
      accepted: number;
      rejected: number;
      inserted_new: null;
      deduped_existing: null;
      deduped_in_batch: number | null;
      sample_window: {
        min_sample_time: string | null;
        max_sample_time: string | null;
      };
    }
  >;
}

export interface IdempotencyReceipt {
  idempotency_key: string;
  payload_hash?: string;
  response: BatchResponseBody;
}

export interface SyncReceiptRecord {
  received_at: string;
  context: string;
  sync_run_id: string;
  receipt_id: string;
  outcome: "processed" | "failed";
  idempotency_key?: string;
  batch_id?: string;
  payload_hash?: string;
  metric: string;
  batch_index: number;
  total_batches: number;
  sync_mode?: string;
  anchor_present?: string;
  lower_bound_reason?: string;
  full_export?: string;
  query_lower_bound?: string;
  sample_min_time?: string;
  sample_max_time?: string;
  latest_destination_sample_time?: string;
  records_received: number;
  records_accepted: number;
  records_skipped: number;
  records_rejected: number;
  records_deduped_in_batch: number;
  response?: BatchResponseBody;
  failure_status_code?: number;
  failure_reason?: string;
}

export interface SyncRunSummary {
  status: "ok";
  sync_run_id: string;
  receipt_id: string;
  verification_level: "delivery_receipt";
  records_received: number;
  records_accepted: number;
  records_inserted_new: null;
  records_deduped_existing: null;
  storage_result_level: "accepted_only";
  records_skipped: number;
  records_rejected: number;
  records_deduped_in_batch: number;
  sample_window: {
    min_sample_time: string | null;
    max_sample_time: string | null;
  };
  latest_sample_time: string | null;
  batches_seen: number;
  batches_processed: number;
  batches_failed: number;
  metrics: string[];
  oldest_received_at: string;
  newest_receipt_at: string;
}

export interface SyncCoverageMetric {
  metric: string;
  records_received: number;
  records_accepted: number;
  records_inserted_new: null;
  records_deduped_existing: null;
  storage_result_level: "accepted_only";
  records_skipped: number;
  records_rejected: number;
  records_deduped_in_batch: number;
  batches_seen: number;
  newest_receipt_at: string;
  latest_receipt_sample_time: string | null;
  latest_destination_sample_time: string | null;
}

export interface SyncCoverageSummary {
  status: "ok";
  storage_result_level: "accepted_only";
  count: number;
  metrics: SyncCoverageMetric[];
}

export interface RecordSyncReceiptInput {
  contextName: string;
  headers: SyncReceiptHeaders;
  metric: string;
  batchIndex: number;
  totalBatches: number;
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
  recordsDedupedInBatch: number;
  latestDestinationSampleTime?: string;
  response: BatchResponseBody;
}

export interface RecordFailedSyncReceiptInput {
  contextName: string;
  headers: SyncReceiptHeaders;
  metric: string;
  batchIndex: number;
  totalBatches: number;
  recordsReceived: number;
  failureStatusCode: number;
  failureReason: string;
}

export interface SyncReceiptStore {
  getIdempotencyReceipt(
    contextName: string,
    idempotencyKey: string,
  ): Promise<IdempotencyReceipt | undefined>;
  recordBatch(input: RecordSyncReceiptInput): Promise<SyncReceiptRecord | undefined>;
  recordFailedBatch(
    input: RecordFailedSyncReceiptInput,
  ): Promise<SyncReceiptRecord | undefined>;
  getLatestRun(contextName: string): Promise<SyncRunSummary | undefined>;
  getRun(
    contextName: string,
    syncRunId: string,
  ): Promise<SyncRunSummary | undefined>;
  getCoverage(contextName: string): Promise<SyncCoverageSummary>;
}

export function createSyncReceiptStore(config: AppConfig): SyncReceiptStore {
  if (config.stateBackend === "memory") {
    return createMemorySyncReceiptStore();
  }

  return new FileSyncReceiptStore(join(config.dataPath, "receipts"));
}

export function createMemorySyncReceiptStore(
  initialRecords: SyncReceiptRecord[] = [],
): SyncReceiptStore {
  const recordsByContext = new Map<string, SyncReceiptRecord[]>();
  for (const record of initialRecords) {
    contextRecords(recordsByContext, record.context).push(record);
  }

  return {
    async getIdempotencyReceipt(contextName, idempotencyKey) {
      return findIdempotencyReceipt(contextRecords(recordsByContext, contextName), idempotencyKey);
    },
    async recordBatch(input) {
      const record = createReceiptRecord(input);
      if (!record) {
        return undefined;
      }

      contextRecords(recordsByContext, record.context).push(record);
      return record;
    },
    async recordFailedBatch(input) {
      const record = createFailedReceiptRecord(input);
      if (!record) {
        return undefined;
      }

      contextRecords(recordsByContext, record.context).push(record);
      return record;
    },
    async getLatestRun(contextName) {
      return latestRunSummary(contextRecords(recordsByContext, contextName));
    },
    async getRun(contextName, syncRunId) {
      return runSummary(contextRecords(recordsByContext, contextName), syncRunId);
    },
    async getCoverage(contextName) {
      return coverageSummary(contextRecords(recordsByContext, contextName));
    },
  };
}

export class FileSyncReceiptStore implements SyncReceiptStore {
  private readonly contexts = new Map<string, SyncReceiptRecord[]>();
  private readonly loadedContexts = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly basePath: string) {}

  async getIdempotencyReceipt(
    contextName: string,
    idempotencyKey: string,
  ): Promise<IdempotencyReceipt | undefined> {
    const normalizedContextName = normalizeContextName(contextName);
    await this.ensureLoaded(normalizedContextName);
    return findIdempotencyReceipt(
      this.contextRecords(normalizedContextName),
      idempotencyKey,
    );
  }

  async recordBatch(
    input: RecordSyncReceiptInput,
  ): Promise<SyncReceiptRecord | undefined> {
    const record = createReceiptRecord(input);
    if (!record) {
      return undefined;
    }

    return this.enqueue(async () => {
      await this.ensureLoaded(record.context);
      this.contextRecords(record.context).push(record);
      await this.appendRecord(record);
      return record;
    });
  }

  async recordFailedBatch(
    input: RecordFailedSyncReceiptInput,
  ): Promise<SyncReceiptRecord | undefined> {
    const record = createFailedReceiptRecord(input);
    if (!record) {
      return undefined;
    }

    return this.enqueue(async () => {
      await this.ensureLoaded(record.context);
      this.contextRecords(record.context).push(record);
      await this.appendRecord(record);
      return record;
    });
  }

  async getLatestRun(contextName: string): Promise<SyncRunSummary | undefined> {
    const normalizedContextName = normalizeContextName(contextName);
    await this.ensureLoaded(normalizedContextName);
    return latestRunSummary(this.contextRecords(normalizedContextName));
  }

  async getRun(
    contextName: string,
    syncRunId: string,
  ): Promise<SyncRunSummary | undefined> {
    const normalizedContextName = normalizeContextName(contextName);
    await this.ensureLoaded(normalizedContextName);
    return runSummary(this.contextRecords(normalizedContextName), syncRunId);
  }

  async getCoverage(contextName: string): Promise<SyncCoverageSummary> {
    const normalizedContextName = normalizeContextName(contextName);
    await this.ensureLoaded(normalizedContextName);
    return coverageSummary(this.contextRecords(normalizedContextName));
  }

  private async ensureLoaded(contextName: string): Promise<void> {
    if (this.loadedContexts.has(contextName)) {
      return;
    }

    await this.load(contextName);
    this.loadedContexts.add(contextName);
  }

  private async load(contextName: string): Promise<void> {
    const filePath = receiptsFilePath(this.basePath, contextName);
    try {
      const content = await readFile(filePath, "utf8");
      this.contexts.set(contextName, parseReceiptLines(content, contextName));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private contextRecords(contextName: string): SyncReceiptRecord[] {
    const existingRecords = this.contexts.get(contextName);
    if (existingRecords) {
      return existingRecords;
    }

    const nextRecords: SyncReceiptRecord[] = [];
    this.contexts.set(contextName, nextRecords);
    return nextRecords;
  }

  private async appendRecord(record: SyncReceiptRecord): Promise<void> {
    const directory = join(this.basePath, encodeContextName(record.context));
    await mkdir(directory, { recursive: true });
    await appendFile(
      receiptsFilePath(this.basePath, record.context),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const nextOperation = this.operationQueue.then(operation, operation);
    this.operationQueue = nextOperation.then(
      () => undefined,
      () => undefined,
    );
    return nextOperation;
  }
}

export function parseSyncReceiptHeaders(
  headers: IncomingHttpHeaders,
): SyncReceiptHeaders {
  return {
    idempotencyKey: headerString(headers["idempotency-key"]),
    syncRunId: headerString(headers["x-healthsave-sync-run-id"]),
    batchId: headerString(headers["x-healthsave-batch-id"]),
    payloadHash: headerString(headers["x-healthsave-payload-hash"]),
    metric: headerString(headers["x-healthsave-metric"]),
    batchIndex: headerString(headers["x-healthsave-batch-index"]),
    totalBatches: headerString(headers["x-healthsave-total-batches"]),
    syncMode: headerString(headers["x-healthsave-sync-mode"]),
    anchorPresent: headerString(headers["x-healthsave-anchor-present"]),
    lowerBoundReason: headerString(headers["x-healthsave-lower-bound-reason"]),
    fullExport: headerString(headers["x-healthsave-full-export"]),
    queryLowerBound: headerString(headers["x-healthsave-query-lower-bound"]),
    sampleMinTime: parseOptionalTimestamp(
      headerString(headers["x-healthsave-sample-min-time"]),
    ),
    sampleMaxTime: parseOptionalTimestamp(
      headerString(headers["x-healthsave-sample-max-time"]),
    ),
  };
}

function createReceiptRecord(
  input: RecordSyncReceiptInput,
): SyncReceiptRecord | undefined {
  const syncRunId = input.headers.syncRunId?.trim();
  if (!syncRunId) {
    return undefined;
  }

  const receivedAt = new Date().toISOString();
  const recordsRejected = Math.max(0, input.recordsRejected);
  return {
    received_at: receivedAt,
    context: normalizeContextName(input.contextName),
    sync_run_id: syncRunId,
    receipt_id: input.response.receipt_id,
    outcome: "processed",
    ...optionalField("idempotency_key", input.headers.idempotencyKey),
    ...optionalField("batch_id", input.headers.batchId),
    ...optionalField("payload_hash", input.headers.payloadHash),
    metric: input.headers.metric ?? input.metric,
    batch_index: parseInteger(input.headers.batchIndex) ?? input.batchIndex,
    total_batches: parseInteger(input.headers.totalBatches) ?? input.totalBatches,
    ...optionalField("sync_mode", input.headers.syncMode),
    ...optionalField("anchor_present", input.headers.anchorPresent),
    ...optionalField("lower_bound_reason", input.headers.lowerBoundReason),
    ...optionalField("full_export", input.headers.fullExport),
    ...optionalField("query_lower_bound", input.headers.queryLowerBound),
    ...optionalField("sample_min_time", input.headers.sampleMinTime),
    ...optionalField("sample_max_time", input.headers.sampleMaxTime),
    ...optionalField(
      "latest_destination_sample_time",
      input.latestDestinationSampleTime,
    ),
    records_received: input.recordsReceived,
    records_accepted: input.recordsAccepted,
    records_skipped: recordsRejected,
    records_rejected: recordsRejected,
    records_deduped_in_batch: input.recordsDedupedInBatch,
    response: input.response,
  };
}

function createFailedReceiptRecord(
  input: RecordFailedSyncReceiptInput,
): SyncReceiptRecord | undefined {
  const syncRunId = input.headers.syncRunId?.trim();
  if (!syncRunId) {
    return undefined;
  }

  const receivedAt = new Date().toISOString();
  return {
    received_at: receivedAt,
    context: normalizeContextName(input.contextName),
    sync_run_id: syncRunId,
    receipt_id:
      input.headers.idempotencyKey ??
      input.headers.batchId ??
      `${syncRunId}:${input.metric}:${input.batchIndex}`,
    outcome: "failed",
    ...optionalField("idempotency_key", input.headers.idempotencyKey),
    ...optionalField("batch_id", input.headers.batchId),
    ...optionalField("payload_hash", input.headers.payloadHash),
    metric: input.headers.metric ?? input.metric,
    batch_index: parseInteger(input.headers.batchIndex) ?? input.batchIndex,
    total_batches: parseInteger(input.headers.totalBatches) ?? input.totalBatches,
    ...optionalField("sync_mode", input.headers.syncMode),
    ...optionalField("anchor_present", input.headers.anchorPresent),
    ...optionalField("lower_bound_reason", input.headers.lowerBoundReason),
    ...optionalField("full_export", input.headers.fullExport),
    ...optionalField("query_lower_bound", input.headers.queryLowerBound),
    ...optionalField("sample_min_time", input.headers.sampleMinTime),
    ...optionalField("sample_max_time", input.headers.sampleMaxTime),
    records_received: input.recordsReceived,
    records_accepted: 0,
    records_skipped: 0,
    records_rejected: 0,
    records_deduped_in_batch: 0,
    failure_status_code: input.failureStatusCode,
    failure_reason: input.failureReason,
  };
}

function findIdempotencyReceipt(
  records: SyncReceiptRecord[],
  idempotencyKey: string,
): IdempotencyReceipt | undefined {
  const key = idempotencyKey.trim();
  if (!key) {
    return undefined;
  }

  const record = [...records]
    .reverse()
    .find(
      (candidate) =>
        candidate.idempotency_key === key &&
        candidate.outcome !== "failed" &&
        candidate.response,
    );
  if (!record?.response) {
    return undefined;
  }

  return {
    idempotency_key: key,
    payload_hash: record.payload_hash,
    response: record.response,
  };
}

function latestRunSummary(
  records: SyncReceiptRecord[],
): SyncRunSummary | undefined {
  const latestRecord = records.reduce<SyncReceiptRecord | undefined>(
    (latest, record) =>
      !latest || record.received_at > latest.received_at ? record : latest,
    undefined,
  );
  return latestRecord
    ? runSummary(records, latestRecord.sync_run_id)
    : undefined;
}

function runSummary(
  records: SyncReceiptRecord[],
  syncRunId: string,
): SyncRunSummary | undefined {
  const runRecords = records.filter((record) => record.sync_run_id === syncRunId);
  if (runRecords.length === 0) {
    return undefined;
  }

  const sampleMinTimes = runRecords.flatMap((record) =>
    record.sample_min_time ? [record.sample_min_time] : [],
  );
  const sampleMaxTimes = runRecords.flatMap((record) =>
    record.sample_max_time ? [record.sample_max_time] : [],
  );
  const newestReceiptAt = maxString(runRecords.map((record) => record.received_at));
  const processedRecords = runRecords.filter(
    (record) => record.outcome !== "failed",
  );
  const failedRecords = runRecords.filter((record) => record.outcome === "failed");

  return {
    status: "ok",
    sync_run_id: syncRunId,
    receipt_id: syncRunId,
    verification_level: "delivery_receipt",
    records_received: sum(runRecords, "records_received"),
    records_accepted: sum(runRecords, "records_accepted"),
    records_inserted_new: null,
    records_deduped_existing: null,
    storage_result_level: "accepted_only",
    records_skipped: sum(runRecords, "records_skipped"),
    records_rejected: sum(runRecords, "records_rejected"),
    records_deduped_in_batch: sum(runRecords, "records_deduped_in_batch"),
    sample_window: {
      min_sample_time: minString(sampleMinTimes),
      max_sample_time: maxString(sampleMaxTimes),
    },
    latest_sample_time: maxString(sampleMaxTimes),
    batches_seen: uniqueBatchCount(runRecords),
    batches_processed: processedRecords.length,
    batches_failed: failedRecords.length,
    metrics: [...new Set(runRecords.map((record) => record.metric))].sort(),
    oldest_received_at: minString(runRecords.map((record) => record.received_at))!,
    newest_receipt_at: newestReceiptAt!,
  };
}

function coverageSummary(records: SyncReceiptRecord[]): SyncCoverageSummary {
  const recordsByMetric = new Map<string, SyncReceiptRecord[]>();
  for (const record of records) {
    const metricRecords = recordsByMetric.get(record.metric) ?? [];
    metricRecords.push(record);
    recordsByMetric.set(record.metric, metricRecords);
  }

  const metrics = [...recordsByMetric.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([metric, metricRecords]) => ({
      metric,
      records_received: sum(metricRecords, "records_received"),
      records_accepted: sum(metricRecords, "records_accepted"),
      records_inserted_new: null,
      records_deduped_existing: null,
      storage_result_level: "accepted_only" as const,
      records_skipped: sum(metricRecords, "records_skipped"),
      records_rejected: sum(metricRecords, "records_rejected"),
      records_deduped_in_batch: sum(metricRecords, "records_deduped_in_batch"),
      batches_seen: uniqueBatchCount(metricRecords),
      newest_receipt_at: maxString(metricRecords.map((record) => record.received_at))!,
      latest_receipt_sample_time: maxString(
        metricRecords.flatMap((record) =>
          record.sample_max_time ? [record.sample_max_time] : [],
        ),
      ),
      latest_destination_sample_time: maxString(
        metricRecords.flatMap((record) =>
          record.latest_destination_sample_time
            ? [record.latest_destination_sample_time]
            : [],
        ),
      ),
    }));

  return {
    status: "ok",
    storage_result_level: "accepted_only",
    count: metrics.length,
    metrics,
  };
}

function contextRecords(
  recordsByContext: Map<string, SyncReceiptRecord[]>,
  contextName: string,
): SyncReceiptRecord[] {
  const normalizedContextName = normalizeContextName(contextName);
  const existingRecords = recordsByContext.get(normalizedContextName);
  if (existingRecords) {
    return existingRecords;
  }

  const nextRecords: SyncReceiptRecord[] = [];
  recordsByContext.set(normalizedContextName, nextRecords);
  return nextRecords;
}

function parseReceiptLines(
  content: string,
  contextName: string,
): SyncReceiptRecord[] {
  const records: SyncReceiptRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const parsed = JSON.parse(trimmed) as Partial<SyncReceiptRecord>;
    if (
      parsed.context === contextName &&
      typeof parsed.sync_run_id === "string" &&
      typeof parsed.received_at === "string" &&
      typeof parsed.metric === "string" &&
      typeof parsed.batch_index === "number" &&
      typeof parsed.total_batches === "number" &&
      typeof parsed.records_received === "number" &&
      typeof parsed.records_accepted === "number" &&
      typeof parsed.records_rejected === "number" &&
      typeof parsed.records_skipped === "number" &&
      typeof parsed.records_deduped_in_batch === "number" &&
      (parsed.outcome === "failed" ||
        parsed.outcome === "processed" ||
        parsed.outcome === undefined) &&
      (parsed.outcome === "failed" || isBatchResponseBody(parsed.response))
    ) {
      records.push({
        ...(parsed as SyncReceiptRecord),
        outcome: parsed.outcome ?? "processed",
      });
    }
  }

  return records;
}

function isBatchResponseBody(value: unknown): value is BatchResponseBody {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Partial<BatchResponseBody>).status !== undefined &&
    typeof (value as Partial<BatchResponseBody>).metric === "string" &&
    typeof (value as Partial<BatchResponseBody>).batch === "number" &&
    typeof (value as Partial<BatchResponseBody>).total_batches === "number" &&
    typeof (value as Partial<BatchResponseBody>).records === "number" &&
    typeof (value as Partial<BatchResponseBody>).receipt_id === "string" &&
    (value as Partial<BatchResponseBody>).verification_level ===
      "delivery_receipt"
  );
}

function receiptsFilePath(basePath: string, contextName: string): string {
  return join(basePath, encodeContextName(contextName), "receipts.ndjson");
}

function normalizeContextName(contextName: string): string {
  return contextName.trim() || "default";
}

function headerString(value: string | string[] | undefined): string | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const trimmed = rawValue?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalTimestamp(value: string | undefined): string | undefined {
  return value ? parseTimestamp(value) : undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function optionalField<Key extends string>(
  key: Key,
  value: string | undefined,
): Record<Key, string> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}

function sum(
  records: SyncReceiptRecord[],
  key:
    | "records_received"
    | "records_accepted"
    | "records_skipped"
    | "records_rejected"
    | "records_deduped_in_batch",
): number {
  return records.reduce((total, record) => total + record[key], 0);
}

function minString(values: string[]): string | null {
  return values.length > 0 ? values.reduce((min, value) => value < min ? value : min) : null;
}

function maxString(values: string[]): string | null {
  return values.length > 0 ? values.reduce((max, value) => value > max ? value : max) : null;
}

function uniqueBatchCount(records: SyncReceiptRecord[]): number {
  return new Set(
    records.map((record) =>
      record.batch_id ?? `${record.metric}:${record.batch_index}:${record.total_batches}`,
    ),
  ).size;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
