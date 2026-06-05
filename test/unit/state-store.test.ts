import { mkdtempSync, rmSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SQLiteStateStore,
  type StateStoreLogger,
} from "../../src/state/store.js";

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

interface LogEntry {
  level: "info" | "warn" | "error";
  bindings: Record<string, unknown>;
  message: string;
}

function createRecordingLogger(): StateStoreLogger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry["level"]) =>
    (
      bindingsOrMessage: Record<string, unknown> | string,
      maybeMessage?: string,
    ) => {
      entries.push({
        level,
        bindings:
          typeof bindingsOrMessage === "string" ? {} : bindingsOrMessage,
        message:
          typeof bindingsOrMessage === "string"
            ? bindingsOrMessage
            : (maybeMessage ?? ""),
      });
    };

  return {
    entries,
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

function legacyObservationLine(
  statusMetric: string,
  identityKey: string,
  observedAt: string,
): string {
  return `${JSON.stringify({ statusMetric, identityKey, observedAt })}\n`;
}

async function writeLegacyLedger(
  statePath: string,
  contextName: string,
  content: string,
): Promise<string> {
  const contextPath = join(statePath, contextName);
  await mkdir(contextPath, { recursive: true });
  const ledgerPath = join(contextPath, "observations.ndjson");
  await writeFile(ledgerPath, content, "utf8");
  return ledgerPath;
}

describe("SQLiteStateStore", () => {
  it("returns zero/null status objects for known metrics", async () => {
    const store = new SQLiteStateStore(createTempStatePath());

    await expect(store.getStatus("default")).resolves.toEqual({
      heart_rate: { count: 0, oldest: null, newest: null },
      hrv: { count: 0, oldest: null, newest: null },
      blood_oxygen: { count: 0, oldest: null, newest: null },
      daily_activity: { count: 0, oldest: null, newest: null },
      sleep_sessions: { count: 0, oldest: null, newest: null },
      workouts: { count: 0, oldest: null, newest: null },
      quantity_samples: { count: 0, oldest: null, newest: null },
    });
    await store.close();
  });

  it("deduplicates repeated observations and tracks oldest/newest", async () => {
    const store = new SQLiteStateStore(createTempStatePath());

    await expect(
      store.applyObservations(
        [
          {
            statusMetric: "heart_rate",
            deviceId: "Watch",
            observedAt: "2026-04-10T12:00:00.000Z",
          },
          {
            statusMetric: "heart_rate",
            deviceId: "Watch",
            observedAt: "2026-04-10T12:00:00.000Z",
          },
          {
            statusMetric: "heart_rate",
            deviceId: "Watch",
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
    await store.close();
  });

  it("persists status observations by context across reloads", async () => {
    const statePath = createTempStatePath();
    const store = new SQLiteStateStore(statePath);

    await store.applyObservations(
      [
        {
          statusMetric: "heart_rate",
          deviceId: "Watch",
          observedAt: "2026-04-10T12:00:00.000Z",
        },
      ],
      "default",
    );
    await store.applyObservations(
      [
        {
          statusMetric: "quantity_samples",
          deviceId: "Phone",
          secondaryKey: "walking_speed",
          observedAt: "2026-04-10T08:00:00.000Z",
        },
      ],
      "daniel",
    );
    await store.close();

    const reloadedStore = new SQLiteStateStore(statePath);

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
    await reloadedStore.close();
  });

  it("writes a sqlite status database under the configured path", async () => {
    const statePath = createTempStatePath();
    const store = new SQLiteStateStore(statePath);

    await store.applyObservations(
      [
        {
          statusMetric: "hrv",
          deviceId: "Watch",
          observedAt: "2026-04-10T12:00:00.000Z",
        },
      ],
      "default",
    );

    const sqlitePath = join(statePath, "status.sqlite");
    await expect(access(sqlitePath)).resolves.toBeUndefined();
    await expect(
      access(join(statePath, "default", "observations.ndjson")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await store.close();
  });

  it("migrates legacy ndjson ledgers without appending to them", async () => {
    const statePath = createTempStatePath();
    const legacyContent = [
      legacyObservationLine(
        "heart_rate",
        "Daniel:Watch:2026-04-10T12:00:00.000Z",
        "2026-04-10T12:00:00.000Z",
      ),
      legacyObservationLine(
        "quantity_samples",
        "Daniel:Phone:walking_speed:2026-04-09T07:30:00.000Z",
        "2026-04-09T07:30:00.000Z",
      ),
    ].join("");
    const ledgerPath = await writeLegacyLedger(
      statePath,
      "daniel",
      legacyContent,
    );
    const logger = createRecordingLogger();

    const store = new SQLiteStateStore(statePath, logger);

    await expect(store.getStatus("daniel")).resolves.toMatchObject({
      heart_rate: {
        count: 1,
        oldest: "2026-04-10T12:00:00.000Z",
        newest: "2026-04-10T12:00:00.000Z",
      },
      quantity_samples: {
        count: 1,
        oldest: "2026-04-09T07:30:00.000Z",
        newest: "2026-04-09T07:30:00.000Z",
      },
    });
    await expect(readFile(ledgerPath, "utf8")).resolves.toBe(legacyContent);
    expect(logger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: "finished sqlite status legacy migration",
          bindings: expect.objectContaining({
            contexts: 1,
            scanned_rows: 2,
            inserted_rows: 2,
            duplicate_rows: 0,
            skipped_rows: 0,
            migration_marker_written: true,
          }),
        }),
      ]),
    );
    await store.close();
  });

  it("deduplicates legacy rows and warns for malformed legacy rows", async () => {
    const statePath = createTempStatePath();
    await writeLegacyLedger(
      statePath,
      "default",
      [
        legacyObservationLine(
          "heart_rate",
          "Watch:2026-04-10T12:00:00.000Z",
          "2026-04-10T12:00:00.000Z",
        ),
        legacyObservationLine(
          "heart_rate",
          "Watch:2026-04-10T12:00:00.000Z",
          "2026-04-10T12:00:00.000Z",
        ),
        legacyObservationLine(
          "quantity_samples",
          "missing-secondary-key-2026-04-10T12:00:00.000Z",
          "2026-04-10T12:00:00.000Z",
        ),
        "{not-json}\n",
      ].join(""),
    );
    const logger = createRecordingLogger();

    const store = new SQLiteStateStore(statePath, logger);

    await expect(store.getStatus("default")).resolves.toMatchObject({
      heart_rate: {
        count: 1,
        oldest: "2026-04-10T12:00:00.000Z",
        newest: "2026-04-10T12:00:00.000Z",
      },
    });
    expect(logger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: "skipped malformed sqlite status legacy row",
          bindings: expect.objectContaining({
            context: "default",
            line_number: 3,
            reason: "identity_missing_observed_at_suffix",
            status_metric: "quantity_samples",
          }),
        }),
        expect.objectContaining({
          level: "warn",
          message: "skipped malformed sqlite status legacy row",
          bindings: expect.objectContaining({
            context: "default",
            line_number: 4,
            reason: "invalid_json",
          }),
        }),
        expect.objectContaining({
          level: "info",
          message: "finished sqlite status legacy migration",
          bindings: expect.objectContaining({
            scanned_rows: 4,
            inserted_rows: 1,
            duplicate_rows: 1,
            skipped_rows: 2,
          }),
        }),
      ]),
    );
    await store.close();
  });

  it("skips legacy migration after the marker exists", async () => {
    const statePath = createTempStatePath();
    await writeLegacyLedger(
      statePath,
      "default",
      legacyObservationLine(
        "heart_rate",
        "Watch:2026-04-10T12:00:00.000Z",
        "2026-04-10T12:00:00.000Z",
      ),
    );

    const firstStore = new SQLiteStateStore(statePath);
    await firstStore.close();
    await writeLegacyLedger(
      statePath,
      "daniel",
      legacyObservationLine(
        "hrv",
        "Watch:2026-04-11T12:00:00.000Z",
        "2026-04-11T12:00:00.000Z",
      ),
    );
    const logger = createRecordingLogger();

    const secondStore = new SQLiteStateStore(statePath, logger);

    await expect(secondStore.getStatus("default")).resolves.toMatchObject({
      heart_rate: {
        count: 1,
        oldest: "2026-04-10T12:00:00.000Z",
        newest: "2026-04-10T12:00:00.000Z",
      },
    });
    await expect(secondStore.getStatus("daniel")).resolves.toMatchObject({
      hrv: { count: 0, oldest: null, newest: null },
    });
    expect(logger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: "sqlite status legacy migration skipped",
        }),
      ]),
    );
    await secondStore.close();
  });

  it("reports readiness false after close", async () => {
    const store = new SQLiteStateStore(createTempStatePath());

    expect(store.isReady()).toBe(true);
    await store.close();

    expect(store.isReady()).toBe(false);
  });
});
