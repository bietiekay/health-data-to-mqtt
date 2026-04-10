import { describe, expect, it } from "vitest";
import { batchRequestSchema, counterForMetric } from "../../src/ingest.js";
import { renderMetricTopic } from "../../src/mqtt/topics.js";

describe("counterForMetric", () => {
  it("maps reference metrics to status counters", () => {
    expect(counterForMetric("heart_rate")).toBe("heart_rate");
    expect(counterForMetric("heart_rate_variability")).toBe("hrv");
    expect(counterForMetric("blood_oxygen")).toBe("blood_oxygen");
    expect(counterForMetric("activity_summaries")).toBe("daily_activity");
    expect(counterForMetric("sleep_analysis")).toBe("sleep_sessions");
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
});

describe("renderMetricTopic", () => {
  it("renders metric placeholders in topic templates", () => {
    expect(renderMetricTopic("healthsave/raw/{metric}", "heart_rate")).toBe(
      "healthsave/raw/heart_rate",
    );
  });
});
