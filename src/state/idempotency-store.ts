import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { encodeContextName } from "../storage/raw-batch-storage.js";
import type { BatchResponseBody } from "./sync-receipts.js";

export interface IdempotencyEntry {
  idempotency_key: string;
  payload_hash?: string;
  response: BatchResponseBody;
  recorded_at: string;
}

export interface RecordIdempotencyInput {
  contextName: string;
  idempotencyKey: string;
  payloadHash?: string;
  response: BatchResponseBody;
}

export interface IdempotencyStore {
  getEntry(
    contextName: string,
    idempotencyKey: string,
  ): Promise<IdempotencyEntry | undefined>;
  recordSuccess(input: RecordIdempotencyInput): Promise<IdempotencyEntry>;
}

export function createIdempotencyStore(config: AppConfig): IdempotencyStore {
  if (config.stateBackend === "memory") {
    return createMemoryIdempotencyStore();
  }

  return new FileIdempotencyStore(join(config.dataPath, "idempotency"));
}

export function createMemoryIdempotencyStore(
  initialEntries: Array<IdempotencyEntry & { context?: string }> = [],
): IdempotencyStore {
  const entriesByContext = new Map<string, IdempotencyEntry[]>();
  for (const entry of initialEntries) {
    contextEntries(entriesByContext, entry.context ?? "default").push(entry);
  }

  return {
    async getEntry(contextName, idempotencyKey) {
      return findEntry(contextEntries(entriesByContext, contextName), idempotencyKey);
    },
    async recordSuccess(input) {
      const entry = createEntry(input);
      const entries = contextEntries(entriesByContext, input.contextName);
      const existingEntry = findEntry(entries, entry.idempotency_key);
      if (existingEntry) {
        return existingEntry;
      }

      entries.push(entry);
      return entry;
    },
  };
}

export class FileIdempotencyStore implements IdempotencyStore {
  private readonly contexts = new Map<string, IdempotencyEntry[]>();
  private readonly loadedContexts = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly basePath: string) {}

  async getEntry(
    contextName: string,
    idempotencyKey: string,
  ): Promise<IdempotencyEntry | undefined> {
    const normalizedContextName = normalizeContextName(contextName);
    await this.ensureLoaded(normalizedContextName);
    return findEntry(
      this.contextEntries(normalizedContextName),
      idempotencyKey,
    );
  }

  async recordSuccess(input: RecordIdempotencyInput): Promise<IdempotencyEntry> {
    const contextName = normalizeContextName(input.contextName);
    return this.enqueue(async () => {
      await this.ensureLoaded(contextName);
      const entries = this.contextEntries(contextName);
      const existingEntry = findEntry(entries, input.idempotencyKey);
      if (existingEntry) {
        return existingEntry;
      }

      const entry = createEntry({ ...input, contextName });
      entries.push(entry);
      await this.appendEntry(contextName, entry);
      return entry;
    });
  }

  private async ensureLoaded(contextName: string): Promise<void> {
    if (this.loadedContexts.has(contextName)) {
      return;
    }

    await this.load(contextName);
    this.loadedContexts.add(contextName);
  }

  private async load(contextName: string): Promise<void> {
    const filePath = indexFilePath(this.basePath, contextName);
    try {
      const content = await readFile(filePath, "utf8");
      this.contexts.set(contextName, parseEntryLines(content));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private contextEntries(contextName: string): IdempotencyEntry[] {
    const existingEntries = this.contexts.get(contextName);
    if (existingEntries) {
      return existingEntries;
    }

    const nextEntries: IdempotencyEntry[] = [];
    this.contexts.set(contextName, nextEntries);
    return nextEntries;
  }

  private async appendEntry(
    contextName: string,
    entry: IdempotencyEntry,
  ): Promise<void> {
    const directory = join(this.basePath, encodeContextName(contextName));
    await mkdir(directory, { recursive: true });
    await appendFile(
      indexFilePath(this.basePath, contextName),
      `${JSON.stringify(entry)}\n`,
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

function createEntry(input: RecordIdempotencyInput): IdempotencyEntry {
  return {
    idempotency_key: input.idempotencyKey.trim(),
    ...optionalField("payload_hash", input.payloadHash),
    response: input.response,
    recorded_at: new Date().toISOString(),
  };
}

function contextEntries(
  entriesByContext: Map<string, IdempotencyEntry[]>,
  contextName: string,
): IdempotencyEntry[] {
  const normalizedContextName = normalizeContextName(contextName);
  const existingEntries = entriesByContext.get(normalizedContextName);
  if (existingEntries) {
    return existingEntries;
  }

  const nextEntries: IdempotencyEntry[] = [];
  entriesByContext.set(normalizedContextName, nextEntries);
  return nextEntries;
}

function findEntry(
  entries: IdempotencyEntry[],
  idempotencyKey: string,
): IdempotencyEntry | undefined {
  const key = idempotencyKey.trim();
  if (!key) {
    return undefined;
  }

  return [...entries]
    .reverse()
    .find((entry) => entry.idempotency_key === key);
}

function parseEntryLines(content: string): IdempotencyEntry[] {
  const entries: IdempotencyEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const parsed = JSON.parse(trimmed) as Partial<IdempotencyEntry>;
    if (
      typeof parsed.idempotency_key === "string" &&
      parsed.idempotency_key.length > 0 &&
      typeof parsed.recorded_at === "string" &&
      isBatchResponseBody(parsed.response)
    ) {
      entries.push({
        idempotency_key: parsed.idempotency_key,
        ...optionalField("payload_hash", parsed.payload_hash),
        response: parsed.response,
        recorded_at: parsed.recorded_at,
      });
    }
  }

  return entries;
}

function isBatchResponseBody(value: unknown): value is BatchResponseBody {
  return (
    value !== null &&
    typeof value === "object" &&
    ((value as Partial<BatchResponseBody>).status === "processed" ||
      (value as Partial<BatchResponseBody>).status === "empty") &&
    typeof (value as Partial<BatchResponseBody>).metric === "string" &&
    typeof (value as Partial<BatchResponseBody>).batch === "number" &&
    typeof (value as Partial<BatchResponseBody>).total_batches === "number" &&
    typeof (value as Partial<BatchResponseBody>).records === "number" &&
    typeof (value as Partial<BatchResponseBody>).receipt_id === "string" &&
    (value as Partial<BatchResponseBody>).verification_level ===
      "delivery_receipt"
  );
}

function indexFilePath(basePath: string, contextName: string): string {
  return join(basePath, encodeContextName(contextName), "keys.ndjson");
}

function normalizeContextName(contextName?: string): string {
  return contextName?.trim() || "default";
}

function optionalField<Key extends string>(
  key: Key,
  value: string | undefined,
): Record<Key, string> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, string>);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
