import { mkdtempSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStateStore } from "../../src/state/store.js";

let tempDirectory: string | undefined;

function createTempStatePath(): string {
  tempDirectory = mkdtempSync(join(tmpdir(), "health-state-store-"));
  return join(tempDirectory, "status");
}

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("FileStateStore", () => {
  it("returns zero/null status objects for known metrics", async () => {
    const store = new FileStateStore(createTempStatePath());

    await expect(store.getStatus("default")).resolves.toEqual({
      heart_rate: { count: 0, oldest: null, newest: null },
      hrv: { count: 0, oldest: null, newest: null },
      blood_oxygen: { count: 0, oldest: null, newest: null },
      daily_activity: { count: 0, oldest: null, newest: null },
      sleep_sessions: { count: 0, oldest: null, newest: null },
      workouts: { count: 0, oldest: null, newest: null },
      quantity_samples: { count: 0, oldest: null, newest: null },
    });
  });

  it("deduplicates repeated observations and tracks oldest/newest", async () => {
    const store = new FileStateStore(createTempStatePath());

    await expect(
      store.applyObservations(
        [
          {
            statusMetric: "heart_rate",
            identityKey: "Watch:2026-04-10T12:00:00.000Z",
            observedAt: "2026-04-10T12:00:00.000Z",
          },
          {
            statusMetric: "heart_rate",
            identityKey: "Watch:2026-04-10T12:00:00.000Z",
            observedAt: "2026-04-10T12:00:00.000Z",
          },
          {
            statusMetric: "heart_rate",
            identityKey: "Watch:2026-04-08T09:00:00.000Z",
            observedAt: "2026-04-08T09:00:00.000Z",
          },
        ],
        "default",
      ),
    ).resolves.toEqual({
      applied: 2,
      duplicates: 1,
    });

    await expect(store.getStatus("default")).resolves.toMatchObject({
      heart_rate: {
        count: 2,
        oldest: "2026-04-08T09:00:00.000Z",
        newest: "2026-04-10T12:00:00.000Z",
      },
    });
  });

  it("persists status observations by context across reloads", async () => {
    const statePath = createTempStatePath();
    const store = new FileStateStore(statePath);

    await store.applyObservations(
      [
        {
          statusMetric: "heart_rate",
          identityKey: "Watch:2026-04-10T12:00:00.000Z",
          observedAt: "2026-04-10T12:00:00.000Z",
        },
      ],
      "default",
    );
    await store.applyObservations(
      [
        {
          statusMetric: "quantity_samples",
          identityKey: "Phone:walking_speed:2026-04-10T08:00:00.000Z",
          observedAt: "2026-04-10T08:00:00.000Z",
        },
      ],
      "daniel",
    );

    const reloadedStore = new FileStateStore(statePath);

    await expect(reloadedStore.getStatus("default")).resolves.toMatchObject({
      heart_rate: {
        count: 1,
        oldest: "2026-04-10T12:00:00.000Z",
        newest: "2026-04-10T12:00:00.000Z",
      },
      quantity_samples: {
        count: 0,
        oldest: null,
        newest: null,
      },
    });
    await expect(reloadedStore.getStatus("daniel")).resolves.toMatchObject({
      heart_rate: {
        count: 0,
        oldest: null,
        newest: null,
      },
      quantity_samples: {
        count: 1,
        oldest: "2026-04-10T08:00:00.000Z",
        newest: "2026-04-10T08:00:00.000Z",
      },
    });
  });

  it("writes an observations ledger under the configured path", async () => {
    const statePath = createTempStatePath();
    const store = new FileStateStore(statePath);

    await store.applyObservations(
      [
        {
          statusMetric: "hrv",
          identityKey: "Watch:2026-04-10T12:00:00.000Z",
          observedAt: "2026-04-10T12:00:00.000Z",
        },
      ],
      "default",
    );

    const ledgerPath = join(statePath, "default", "observations.ndjson");
    await expect(access(ledgerPath)).resolves.toBeUndefined();
    await expect(readFile(ledgerPath, "utf8")).resolves.toContain('"statusMetric":"hrv"');
  });
});
