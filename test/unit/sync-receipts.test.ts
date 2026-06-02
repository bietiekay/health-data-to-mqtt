import { mkdtempSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSyncReceiptStore,
  createMemorySyncReceiptStore,
  parseSyncReceiptHeaders,
} from "../../src/state/sync-receipts.js";

let tempDirectory: string | undefined;

function createTempReceiptsPath(): string {
  tempDirectory = mkdtempSync(join(tmpdir(), "health-sync-receipts-"));
  return join(tempDirectory, "receipts");
}

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("parseSyncReceiptHeaders", () => {
  it("extracts HealthSave sync receipt headers", () => {
    expect(
      parseSyncReceiptHeaders({
        "idempotency-key": " key-1 ",
        "x-healthsave-sync-run-id": "run-1",
        "x-healthsave-batch-id": "batch-1",
        "x-healthsave-payload-hash": "hash-1",
        "x-healthsave-metric": "heart_rate",
        "x-healthsave-batch-index": "2",
        "x-healthsave-total-batches": "5",
        "x-healthsave-sync-mode": "incremental",
        "x-healthsave-anchor-present": "true",
        "x-healthsave-lower-bound-reason": "anchor",
        "x-healthsave-full-export": "false",
        "x-healthsave-query-lower-bound": "2026-04-01T00:00:00Z",
        "x-healthsave-sample-min-time": "2026-04-10T12:00:00Z",
        "x-healthsave-sample-max-time": "2026-04-10T12:05:00Z",
      }),
    ).toEqual({
      idempotencyKey: "key-1",
      syncRunId: "run-1",
      batchId: "batch-1",
      payloadHash: "hash-1",
      metric: "heart_rate",
      batchIndex: "2",
      totalBatches: "5",
      syncMode: "incremental",
      anchorPresent: "true",
      lowerBoundReason: "anchor",
      fullExport: "false",
      queryLowerBound: "2026-04-01T00:00:00Z",
      sampleMinTime: "2026-04-10T12:00:00.000Z",
      sampleMaxTime: "2026-04-10T12:05:00.000Z",
    });
  });
});

describe("SyncReceiptStore", () => {
  it("does not record batches without a real sync run id", async () => {
    const store = createMemorySyncReceiptStore();

    await expect(
      store.recordBatch({
        contextName: "default",
        headers: { idempotencyKey: "key-1", payloadHash: "hash-1" },
        metric: "heart_rate",
        batchIndex: 0,
        totalBatches: 1,
        recordsReceived: 1,
        recordsAccepted: 1,
        recordsRejected: 0,
        recordsDedupedInBatch: 0,
        response: {
          status: "processed",
          metric: "heart_rate",
          batch: 0,
          total_batches: 1,
          records: 1,
        },
      }),
    ).resolves.toBeUndefined();
    await expect(store.getLatestRun("default")).resolves.toBeUndefined();
  });

  it("summarizes runs, coverage, and idempotency receipts", async () => {
    const store = createMemorySyncReceiptStore();

    await store.recordBatch({
      contextName: "default",
      headers: {
        idempotencyKey: "key-1",
        syncRunId: "run-1",
        batchId: "batch-1",
        payloadHash: "hash-1",
        sampleMinTime: "2026-04-10T12:00:00.000Z",
        sampleMaxTime: "2026-04-10T12:05:00.000Z",
      },
      metric: "heart_rate",
      batchIndex: 0,
      totalBatches: 2,
      recordsReceived: 3,
      recordsAccepted: 2,
      recordsRejected: 0,
      recordsDedupedInBatch: 1,
      latestDestinationSampleTime: "2026-04-10T12:05:00.000Z",
      response: {
        status: "processed",
        metric: "heart_rate",
        batch: 0,
        total_batches: 2,
        records: 2,
      },
    });
    await store.recordBatch({
      contextName: "default",
      headers: {
        syncRunId: "run-1",
        batchId: "batch-2",
        payloadHash: "hash-2",
        sampleMinTime: "2026-04-10T13:00:00.000Z",
        sampleMaxTime: "2026-04-10T13:00:00.000Z",
      },
      metric: "walking_speed",
      batchIndex: 1,
      totalBatches: 2,
      recordsReceived: 1,
      recordsAccepted: 0,
      recordsRejected: 1,
      recordsDedupedInBatch: 0,
      response: {
        status: "processed",
        metric: "walking_speed",
        batch: 1,
        total_batches: 2,
        records: 0,
      },
    });

    await expect(store.getIdempotencyReceipt("default", "key-1")).resolves.toEqual({
      idempotency_key: "key-1",
      payload_hash: "hash-1",
      response: {
        status: "processed",
        metric: "heart_rate",
        batch: 0,
        total_batches: 2,
        records: 2,
      },
    });
    await expect(store.getRun("default", "run-1")).resolves.toMatchObject({
      status: "ok",
      sync_run_id: "run-1",
      records_received: 4,
      records_accepted: 2,
      records_rejected: 1,
      records_deduped_in_batch: 1,
      sample_window: {
        min_sample_time: "2026-04-10T12:00:00.000Z",
        max_sample_time: "2026-04-10T13:00:00.000Z",
      },
      batches_seen: 2,
      batches_processed: 2,
      batches_failed: 0,
      metrics: ["heart_rate", "walking_speed"],
    });
    await expect(store.getCoverage("default")).resolves.toMatchObject({
      status: "ok",
      count: 2,
      metrics: [
        {
          metric: "heart_rate",
          records_received: 3,
          records_accepted: 2,
          latest_destination_sample_time: "2026-04-10T12:05:00.000Z",
        },
        {
          metric: "walking_speed",
          records_rejected: 1,
          latest_destination_sample_time: null,
        },
      ],
    });
  });

  it("summarizes processed and failed receipt rows separately", async () => {
    const store = createMemorySyncReceiptStore();

    await store.recordFailedBatch({
      contextName: "default",
      headers: {
        syncRunId: "run-1",
        batchId: "batch-1",
        payloadHash: "hash-1",
      },
      metric: "heart_rate",
      batchIndex: 0,
      totalBatches: 2,
      recordsReceived: 3,
      failureStatusCode: 502,
      failureReason: "Failed to publish batch to MQTT",
    });
    await store.recordBatch({
      contextName: "default",
      headers: {
        syncRunId: "run-1",
        batchId: "batch-2",
        payloadHash: "hash-2",
      },
      metric: "heart_rate",
      batchIndex: 1,
      totalBatches: 2,
      recordsReceived: 1,
      recordsAccepted: 1,
      recordsRejected: 0,
      recordsDedupedInBatch: 0,
      response: {
        status: "processed",
        metric: "heart_rate",
        batch: 1,
        total_batches: 2,
        records: 1,
      },
    });

    await expect(store.getRun("default", "run-1")).resolves.toMatchObject({
      sync_run_id: "run-1",
      records_received: 4,
      records_accepted: 1,
      batches_seen: 2,
      batches_processed: 1,
      batches_failed: 1,
      metrics: ["heart_rate"],
    });
  });

  it("persists file-backed receipts by context", async () => {
    const receiptsPath = createTempReceiptsPath();
    const store = new FileSyncReceiptStore(receiptsPath);

    await store.recordBatch({
      contextName: "daniel",
      headers: {
        idempotencyKey: "key-1",
        syncRunId: "run-1",
        payloadHash: "hash-1",
      },
      metric: "heart_rate",
      batchIndex: 0,
      totalBatches: 1,
      recordsReceived: 1,
      recordsAccepted: 1,
      recordsRejected: 0,
      recordsDedupedInBatch: 0,
      response: {
        status: "processed",
        metric: "heart_rate",
        batch: 0,
        total_batches: 1,
        records: 1,
      },
    });

    const ledgerPath = join(receiptsPath, "daniel", "receipts.ndjson");
    await expect(access(ledgerPath)).resolves.toBeUndefined();
    await expect(readFile(ledgerPath, "utf8")).resolves.toContain(
      '"sync_run_id":"run-1"',
    );

    const reloadedStore = new FileSyncReceiptStore(receiptsPath);
    await expect(reloadedStore.getLatestRun("daniel")).resolves.toMatchObject({
      sync_run_id: "run-1",
      records_received: 1,
      records_accepted: 1,
    });
    await expect(reloadedStore.getLatestRun("default")).resolves.toBeUndefined();
  });
});
