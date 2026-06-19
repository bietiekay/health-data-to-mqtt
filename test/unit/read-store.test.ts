import { describe, expect, it } from "vitest";
import type { NormalizedRecord } from "../../src/ingest.js";
import {
  createMemoryReadStore,
  deterministicUuid,
} from "../../src/state/read-store.js";

describe("read store", () => {
  it("creates stable deterministic UUIDs", () => {
    expect(deterministicUuid("stream:apple-healthkit-ios:apple watch")).toBe(
      deterministicUuid("stream:apple-healthkit-ios:apple watch"),
    );
    expect(deterministicUuid("stream:apple-healthkit-ios:apple watch")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("records observations, identity, pagination, and export summaries", async () => {
    const store = createMemoryReadStore();
    const records: NormalizedRecord[] = [
      {
        metric: "heart_rate",
        normalizedMetric: "heart_rate",
        recordIndex: 0,
        deviceId: "Apple Watch",
        normalizedSample: {
          time: "2026-04-10T12:00:00.000Z",
          bpm: 72,
          source_id: "Apple Watch",
        },
      },
      {
        metric: "step_count",
        normalizedMetric: "daily_activity",
        recordIndex: 0,
        deviceId: "iPhone",
        normalizedSample: {
          date: "2026-04-10",
          steps: 1234,
        },
      },
    ];

    await store.recordBatch({
      contextName: "default",
      batch: {
        metric: "heart_rate",
        batch_index: 0,
        total_batches: 1,
        samples: [],
      },
      records,
      ingestedAt: "2026-04-10T12:05:00.000Z",
    });

    await expect(
      store.listObservations("default", { metricId: "vital.heart_rate" }),
    ).resolves.toMatchObject([
      {
        metric_id: "vital.heart_rate",
        value: 72,
        source_id: "apple_watch",
      },
    ]);
    await expect(store.listSources("default")).resolves.toMatchObject({
      count: 1,
      total: 1,
      items: [{ plugin_id: "apple-healthkit-ios" }],
    });
    await expect(store.listStreams("default", { limit: 1 })).resolves.toMatchObject({
      count: 1,
      total: 2,
      items: [expect.objectContaining({ device_label: expect.any(String) })],
    });
    await expect(store.listDevices("default")).resolves.toMatchObject({
      count: 2,
      total: 2,
    });
    await expect(store.listExportMetrics("default")).resolves.toEqual([
      {
        metric: "activity.steps",
        display_name: "Steps",
        count: 1,
        oldest: "2026-04-10T00:00:00Z",
        newest: "2026-04-10T00:00:00Z",
      },
      {
        metric: "vital.heart_rate",
        display_name: "Heart Rate",
        count: 1,
        oldest: "2026-04-10T12:00:00.000Z",
        newest: "2026-04-10T12:00:00.000Z",
      },
    ]);

    await store.close();
  });
});
