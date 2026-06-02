import { mkdtempSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileIdempotencyStore,
  createMemoryIdempotencyStore,
} from "../../src/state/idempotency-store.js";

let tempDirectory: string | undefined;

function createTempIndexPath(): string {
  tempDirectory = mkdtempSync(join(tmpdir(), "health-idempotency-"));
  return join(tempDirectory, "idempotency");
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
      response: {
        status: "processed",
        metric: "heart_rate",
        batch: 0,
        total_batches: 1,
        records: 1,
      },
    });

    await expect(store.getEntry("default", "key-1")).resolves.toMatchObject({
      idempotency_key: "key-1",
      payload_hash: "hash-1",
      response: {
        status: "processed",
        metric: "heart_rate",
        batch: 0,
        total_batches: 1,
        records: 1,
      },
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
      response: {
        status: "processed",
        metric: "heart_rate",
        batch: 0,
        total_batches: 1,
        records: 1,
      },
    });
    const second = await store.recordSuccess({
      contextName: "default",
      idempotencyKey: "key-1",
      payloadHash: "hash-2",
      response: {
        status: "processed",
        metric: "heart_rate",
        batch: 0,
        total_batches: 1,
        records: 2,
      },
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
      response: {
        status: "empty",
        metric: "heart_rate",
        batch: 0,
        records: 0,
      },
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
