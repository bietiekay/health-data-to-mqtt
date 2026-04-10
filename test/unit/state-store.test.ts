import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStateStore } from "../../src/state/store.js";

let tempDirectory: string | undefined;

function createTempStatePath(): string {
  tempDirectory = mkdtempSync(join(tmpdir(), "health-state-store-"));
  return join(tempDirectory, "state.json");
}

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("FileStateStore", () => {
  it("persists status counters by context", async () => {
    const statePath = createTempStatePath();
    const store = new FileStateStore(statePath);

    await store.increment("heart_rate", 2, "default");
    await store.increment("quantity_samples", 3, "daniel");

    const reloadedStore = new FileStateStore(statePath);

    await expect(reloadedStore.getCounts("default")).resolves.toMatchObject({
      heart_rate: 2,
      quantity_samples: 0,
    });
    await expect(reloadedStore.getCounts("daniel")).resolves.toMatchObject({
      heart_rate: 0,
      quantity_samples: 3,
    });
  });

  it("writes a JSON state file under the configured path", async () => {
    const statePath = createTempStatePath();
    const store = new FileStateStore(statePath);

    await store.increment("hrv", 1, "default");

    await expect(readFile(statePath, "utf8")).resolves.toContain(
      '"contexts"',
    );
  });
});
