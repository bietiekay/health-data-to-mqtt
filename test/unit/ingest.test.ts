import { describe, expect, it } from "vitest";
import {
  batchRequestSchema,
  counterForMetric,
  normalizeBatch,
  parseTimestamp,
} from "../../src/ingest.js";
import { renderMetricTopic } from "../../src/mqtt/topics.js";

describe("counterForMetric", () => {
  it("maps reference metrics to status counters", () => {
    expect(counterForMetric("heart_rate")).toBe("heart_rate");
    expect(counterForMetric("heart_rate_variability")).toBe("hrv");
    expect(counterForMetric("blood_oxygen")).toBe("blood_oxygen");
    expect(counterForMetric("activity_summaries")).toBe("daily_activity");
    expect(counterForMetric("sleep_analysis")).toBe("sleep_sessions");
    expect(counterForMetric("workout")).toBe("workouts");
    expect(counterForMetric("workouts")).toBe("workouts");
  });

  it("maps unknown metrics to quantity_samples", () => {
    expect(counterForMetric("step_count")).toBe("quantity_samples");
  });
});

describe("batchRequestSchema", () => {
  it("applies reference-compatible defaults", () => {
    const parsed = batchRequestSchema.parse({});

    expect(parsed).toEqual({
      metric: "unknown",
      batch_index: 0,
      total_batches: 1,
      samples: [],
    });
  });

  it("deserializes JSON-encoded batch and sample wrappers", () => {
    const parsed = batchRequestSchema.parse({
      metric: "heart_rate",
      data: JSON.stringify({
        samples: [
          {
            data: JSON.stringify({
              date: "2026-04-10T12:00:00Z",
              qty: 72,
            }),
          },
        ],
      }),
    });

    expect(parsed.samples).toEqual([
      {
        date: "2026-04-10T12:00:00Z",
        qty: 72,
      },
    ]);
  });
});

describe("normalizeBatch", () => {
  it("extracts dedicated heart rate datapoints", () => {
    expect(
      normalizeBatch({
        metric: "heart_rate",
        batch_index: 0,
        total_batches: 1,
        samples: [{ date: "2026-04-10T12:00:00Z", qty: "72", source: "Watch" }],
      }),
    ).toMatchObject([
      {
        metric: "heart_rate",
        normalizedMetric: "heart_rate",
        recordIndex: 0,
        deviceId: "Watch",
        normalizedSample: {
          time: "2026-04-10T12:00:00.000Z",
          bpm: 72,
          source_id: "Watch",
        },
      },
    ]);
  });

  it("maps unknown quantities into quantity samples", () => {
    expect(
      normalizeBatch({
        metric: "walking_speed",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            date: "2026-04-10T12:00:00Z",
            qty: 1.4,
            unit: "m/s",
            source: "iPhone",
          },
        ],
      })[0]?.normalizedSample,
    ).toEqual({
      time: "2026-04-10T12:00:00.000Z",
      metric_name: "walking_speed",
      value: 1.4,
      unit: "m/s",
      source_id: "iPhone",
    });
  });

  it("maps activity summary aliases", () => {
    expect(
      normalizeBatch({
        metric: "activity_summaries",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            date: "2026-04-10T23:00:00Z",
            steps: 1234,
            activeEnergyBurned: 456,
            appleExerciseTime: 35,
          },
        ],
      })[0]?.normalizedSample,
    ).toEqual({
      date: "2026-04-10",
      steps: 1234,
      active_calories: 456,
      active_minutes: 35,
    });
  });

  it("aggregates sleep stage samples into sessions", () => {
    expect(
      normalizeBatch({
        metric: "sleep_analysis",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            startDate: "2026-04-10T22:00:00Z",
            endDate: "2026-04-10T23:00:00Z",
            value: "deep",
          },
          {
            startDate: "2026-04-10T23:00:00Z",
            endDate: "2026-04-11T00:30:00Z",
            value: "core",
          },
          {
            startDate: "2026-04-11T00:30:00Z",
            endDate: "2026-04-11T00:45:00Z",
            value: "awake",
          },
        ],
      })[0]?.normalizedSample,
    ).toMatchObject({
      start_time: "2026-04-10T22:00:00.000Z",
      end_time: "2026-04-11T00:45:00.000Z",
      total_duration_ms: 9_000_000,
      deep_ms: 3_600_000,
      light_ms: 5_400_000,
      awake_ms: 900_000,
      awake: true,
    });
  });

  it("normalizes workout fields and duration seconds", () => {
    expect(
      normalizeBatch({
        metric: "workouts",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            startDate: "2026-04-10T10:00:00Z",
            endDate: "2026-04-10T11:00:00Z",
            sportType: "cycling",
            duration: 3600,
            avgHeartRate: 120,
            activeEnergyBurned: 500,
          },
        ],
      })[0]?.normalizedSample,
    ).toMatchObject({
      start_time: "2026-04-10T10:00:00.000Z",
      end_time: "2026-04-10T11:00:00.000Z",
      sport_type: "cycling",
      duration_ms: 3_600_000,
      avg_hr: 120,
      calories: 500,
    });
  });

  it("normalizes singular workout active energy as a scalar quantity", () => {
    expect(
      normalizeBatch({
        metric: "workout",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            date: "2021-09-28T22:00:00.000Z",
            activeEnergyBurned: 1015.5210156402777,
            appleExerciseTime: 84,
            appleStandHours: 15,
          },
        ],
      })[0]?.normalizedSample,
    ).toEqual({
      time: "2021-09-28T22:00:00.000Z",
      metric_name: "workout",
      value: 1015.5210156402777,
      unit: "kcal",
      source_id: "",
    });
  });

  it("falls back to active energy when workouts do not include session bounds", () => {
    expect(
      normalizeBatch({
        metric: "workouts",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            date: "2021-09-29T22:00:00.000Z",
            activeEnergyBurned: 1488.1677986518941,
            appleExerciseTime: 166,
            appleStandHours: 13,
          },
        ],
      })[0]?.normalizedSample,
    ).toMatchObject({
      time: "2021-09-29T22:00:00.000Z",
      metric_name: "workouts",
      value: 1488.1677986518941,
      unit: "kcal",
    });
  });
});

describe("parseTimestamp", () => {
  it("normalizes ISO timestamps to UTC", () => {
    expect(parseTimestamp("2026-04-10T14:00:00+02:00")).toBe(
      "2026-04-10T12:00:00.000Z",
    );
  });
});

describe("renderMetricTopic", () => {
  it("renders metric placeholders in topic templates", () => {
    expect(renderMetricTopic("healthsave/raw/{metric}", "heart_rate")).toBe(
      "healthsave/raw/heart_rate",
    );
    expect(
      renderMetricTopic(
        "healthsave/{context}/current/{metric}",
        "heart_rate",
        "daniel",
      ),
    ).toBe("healthsave/daniel/current/heart_rate");
  });
});
