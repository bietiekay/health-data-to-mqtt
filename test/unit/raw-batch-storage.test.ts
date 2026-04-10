import { mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContextConfig } from "../../src/config.js";
import {
  encodeContextName,
  FileRawBatchStorage,
} from "../../src/storage/raw-batch-storage.js";

let tempDirectory: string | undefined;

function createTempDirectory(): string {
  tempDirectory = mkdtempSync(join(tmpdir(), "health-raw-storage-"));
  return tempDirectory;
}

function createContext(name: string): AppContextConfig {
  return {
    name,
    prefix: name === "default" ? "/" : `/${name}`,
    mqtt: {
      topics: {
        raw: "healthsave/raw/{metric}",
        normalized: "healthsave/normalized/{metric}",
        current: "healthsave/current/{metric}",
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("FileRawBatchStorage", () => {
  it("appends newline-delimited batch records by context and UTC month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:30:00.000Z"));
    const basePath = createTempDirectory();
    const storage = new FileRawBatchStorage(basePath);
    const context = createContext("default");
    const body = {
      metric: "heart_rate",
      batch_index: 0,
      total_batches: 1,
      samples: [{ date: "2026-04-30T23:59:00Z", qty: 72 }],
    };

    await storage.storeBatch(context, body, body);
    await storage.storeBatch(context, body, body);

    const content = await readFile(join(basePath, "default", "2026-05"), "utf8");
    const lines = content.trimEnd().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      ingested_at: "2026-05-01T00:30:00.000Z",
      context: "default",
      metric: "heart_rate",
      batch_index: 0,
      total_batches: 1,
      body,
    });
  });

  it("encodes unusual context names without path traversal", async () => {
    const basePath = createTempDirectory();
    const storage = new FileRawBatchStorage(basePath);
    const context = createContext("../alice");
    const body = {
      metric: "step_count",
      batch_index: 0,
      total_batches: 1,
      samples: [{ date: "2026-04-10T12:00:00Z", qty: 120 }],
    };

    await storage.storeBatch(context, body, body);

    expect(await readdir(basePath)).toEqual([encodeContextName("../alice")]);
    expect(encodeContextName("..")).toBe("%2E%2E");
    expect(encodeContextName("../alice")).not.toContain("/");
  });
});
