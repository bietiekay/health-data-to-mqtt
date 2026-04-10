import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig, AppContextConfig } from "../config.js";
import type { BatchRequest } from "../ingest.js";

export interface RawBatchStorageRecord {
  ingested_at: string;
  context: string;
  metric: string;
  batch_index: number;
  total_batches: number;
  body: unknown;
}

export interface RawBatchStorage {
  storeBatch(
    context: AppContextConfig,
    batch: BatchRequest,
    rawBody: unknown,
  ): Promise<RawBatchStorageRecord | undefined>;
}

export function createRawBatchStorage(config: AppConfig): RawBatchStorage {
  if (!config.rawStoragePath) {
    return createNoopRawBatchStorage();
  }

  return new FileRawBatchStorage(config.rawStoragePath);
}

export function createNoopRawBatchStorage(): RawBatchStorage {
  return {
    async storeBatch() {
      return undefined;
    },
  };
}

export class FileRawBatchStorage implements RawBatchStorage {
  constructor(private readonly basePath: string) {}

  async storeBatch(
    context: AppContextConfig,
    batch: BatchRequest,
    rawBody: unknown,
  ): Promise<RawBatchStorageRecord> {
    const ingestedAt = new Date().toISOString();
    const contextDirectory = join(
      this.basePath,
      encodeContextName(context.name),
    );
    const filePath = join(contextDirectory, monthFileName(ingestedAt));
    const record: RawBatchStorageRecord = {
      ingested_at: ingestedAt,
      context: context.name,
      metric: batch.metric,
      batch_index: batch.batch_index,
      total_batches: batch.total_batches,
      body: rawBody,
    };

    await mkdir(contextDirectory, { recursive: true });
    await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");

    return record;
  }
}

export function encodeContextName(contextName: string): string {
  const normalized = contextName.trim() || "default";
  if (/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return normalized;
  }

  return encodeURIComponent(normalized).replace(/\./g, "%2E");
}

function monthFileName(ingestedAt: string): string {
  return ingestedAt.slice(0, 7);
}
