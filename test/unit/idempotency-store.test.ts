import { mkdtempSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileIdempotencyStore,
  createMemoryIdempotencyStore,
} from "../../src/state/idempotency-store.js";
import type { BatchResponseBody } from "../../src/state/sync-receipts.js";

let tempDirectory: string | undefined;

function createTempIndexPath(): string {
  tempDirectory = mkdtempSync(join(tmpdir(), "health-idempotency-"));
  return join(tempDirectory, "idempotency");
}

function batchResponse(
  overrides: Partial<BatchResponseBody> = {},
): BatchResponseBody {
  const metric = overrides.metric ?? "heart_rate";
  const batch = overrides.batch ?? 0;
  const records = overrides.records ?? 1;
  const sampleWindow = {
    min_sample_time: null,
    max_sample_time: null,
  };

  return {
    status: overrides.status ?? "processed",
    metric,
    batch,
    total_batches: overrides.total_batches ?? 1,
    records,
    receipt_id: overrides.receipt_id ?? `runless:${metric}:${batch}`,
    sync_run_id: overrides.sync_run_id ?? null,
    batch_id: overrides.batch_id ?? null,
    idempotency_key: overrides.idempotency_key ?? null,
    batch_index: overrides.batch_index ?? batch,
    records_received: overrides.records_received ?? records,
    records_accepted: overrides.records_accepted ?? records,
    records_rejected: overrides.records_rejected ?? 0,
    records_inserted_new: null,
    records_deduped_existing: null,
    records_deduped_in_batch: overrides.records_deduped_in_batch ?? 0,
    storage_result_level: "accepted_only",
    sample_window: overrides.sample_window ?? sampleWindow,
    verification_level: "delivery_receipt",
    per_metric:
      overrides.per_metric ??
      {
        [metric]: {
          received: overrides.records_received ?? records,
          accepted: overrides.records_accepted ?? records,
          rejected: overrides.records_rejected ?? 0,
          inserted_new: null,
          deduped_existing: null,
          deduped_in_batch: overrides.records_deduped_in_batch ?? 0,
          sample_window: overrides.sample_window ?? sampleWindow,
        },
      },
  };
}

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("IdempotencyStore", () => {
  it("records and replays memory-backed idempotency entries", async () => {
    const store = createMemoryIdempotencyStore();

    await store.recordSuccess({
      contextName: "default",
      idempotencyKey: "key-1",
      payloadHash: "hash-1",
      response: batchResponse(),
    });

    await expect(store.getEntry("default", "key-1")).resolves.toMatchObject({
      idempotency_key: "key-1",
      payload_hash: "hash-1",
      response: batchResponse(),
      recorded_at: expect.any(String),
    });
    await expect(store.getEntry("daniel", "key-1")).resolves.toBeUndefined();
  });

  it("does not overwrite an existing idempotency key", async () => {
    const store = createMemoryIdempotencyStore();

    const first = await store.recordSuccess({
      contextName: "default",
      idempotencyKey: "key-1",
      payloadHash: "hash-1",
      response: batchResponse(),
    });
    const second = await store.recordSuccess({
      contextName: "default",
      idempotencyKey: "key-1",
      payloadHash: "hash-2",
      response: batchResponse({ records: 2 }),
    });

    expect(second).toEqual(first);
    await expect(store.getEntry("default", "key-1")).resolves.toMatchObject({
      payload_hash: "hash-1",
      response: {
        records: 1,
      },
    });
  });

  it("persists file-backed idempotency entries by context", async () => {
    const indexPath = createTempIndexPath();
    const store = new FileIdempotencyStore(indexPath);

    await store.recordSuccess({
      contextName: "daniel",
      idempotencyKey: "key-1",
      payloadHash: "hash-1",
      response: batchResponse({
        status: "empty",
        records: 0,
        records_received: 0,
        records_accepted: 0,
        records_deduped_in_batch: null,
      }),
    });

    const indexFile = join(indexPath, "daniel", "keys.ndjson");
    await expect(access(indexFile)).resolves.toBeUndefined();
    await expect(readFile(indexFile, "utf8")).resolves.toContain(
      '"idempotency_key":"key-1"',
    );

    const reloadedStore = new FileIdempotencyStore(indexPath);
    await expect(reloadedStore.getEntry("daniel", "key-1")).resolves.toMatchObject({
      idempotency_key: "key-1",
      payload_hash: "hash-1",
      response: {
        status: "empty",
        records: 0,
      },
    });
    await expect(reloadedStore.getEntry("default", "key-1")).resolves.toBeUndefined();
  });
});
