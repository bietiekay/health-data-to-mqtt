import { describe, expect, it } from "vitest";
import {
  batchRequestSchema,
  createStatusObservations,
  normalizeBatch,
  normalizeBatchWithStats,
  parseTimestamp,
  resolveDeviceIdentity,
} from "../../src/ingest.js";
import { renderMetricTopic } from "../../src/mqtt/topics.js";

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
  it("reports true rejected and in-batch deduped records separately", () => {
    const result = normalizeBatchWithStats({
      metric: "heart_rate",
      batch_index: 0,
      total_batches: 1,
      samples: [
        { date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" },
        { date: "2026-04-10T12:00:00Z", qty: 73, source: "Watch" },
        { date: "not-a-date", qty: 74, source: "Watch" },
      ],
    });

    expect(result.records).toHaveLength(1);
    expect(result.stats).toEqual({
      recordsReceived: 3,
      recordsAccepted: 1,
      recordsRejected: 1,
      recordsDedupedInBatch: 1,
    });
  });

  it("does not count sleep stage aggregation as in-batch dedupe", () => {
    const result = normalizeBatchWithStats({
      metric: "sleep_analysis",
      batch_index: 0,
      total_batches: 1,
      samples: [
        {
          startDate: "2026-04-10T22:00:00Z",
          endDate: "2026-04-11T02:00:00Z",
          value: "core",
        },
        {
          startDate: "2026-04-11T02:00:00Z",
          endDate: "2026-04-11T06:00:00Z",
          value: "deep",
        },
      ],
    });

    expect(result.records).toHaveLength(1);
    expect(result.stats).toEqual({
      recordsReceived: 2,
      recordsAccepted: 1,
      recordsRejected: 0,
      recordsDedupedInBatch: 0,
    });
  });

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

  it("reports unmapped sample fields on supported metrics", () => {
    const sample = {
      date: "2026-04-10T12:00:00Z",
      qty: 72,
      source: "Watch",
      sourceBundleIdentifier: "com.apple.health",
      heartRateContext: "resting",
    };
    const result = normalizeBatchWithStats({
      metric: "heart_rate",
      batch_index: 0,
      total_batches: 1,
      samples: [sample],
    });

    expect(result.records).toHaveLength(1);
    expect(result.unknownHealthData).toMatchObject({
      metric: "heart_rate",
      mapper: "dedicated_metric",
      normalized_metric: "heart_rate",
      unsupported_metric: false,
      total_samples: 1,
      reported_samples: 1,
      truncated_samples: 0,
      reasons: ["unmapped_sample_fields"],
      unmapped_keys: ["heartRateContext", "sourceBundleIdentifier"],
      candidate_time_fields: ["date"],
      candidate_numeric_fields: ["qty"],
      source_ids: ["Watch"],
      samples: [
        {
          sample_index: 0,
          reasons: ["unmapped_sample_fields"],
          source_id: "Watch",
          unmapped_keys: ["heartRateContext", "sourceBundleIdentifier"],
          expected_time_fields: ["date", "startDate", "start"],
          expected_value_fields: ["qty"],
          missing_time_fields: [],
          missing_value_fields: [],
          candidate_time_fields: ["date"],
          candidate_numeric_fields: ["qty"],
          sample,
        },
      ],
    });
  });

  it("reports unsupported metrics with candidate fields for mapper implementation", () => {
    const result = normalizeBatchWithStats({
      metric: "new_quantity_metric",
      batch_index: 0,
      total_batches: 1,
      samples: [
        {
          startDate: "2026-04-10T12:00:00Z",
          value: 4.2,
          sourceName: "Watch",
          healthKitIdentifier: "HKQuantityTypeIdentifierNewQuantityMetric",
        },
      ],
    });

    expect(result.records).toEqual([]);
    expect(result.stats).toMatchObject({
      recordsReceived: 1,
      recordsAccepted: 0,
      recordsRejected: 1,
    });
    expect(result.unknownHealthData).toMatchObject({
      metric: "new_quantity_metric",
      mapper: "generic_quantity_fallback",
      normalized_metric: "quantity_samples",
      unsupported_metric: true,
      total_samples: 1,
      reasons: [
        "rejected_sample",
        "unmapped_sample_fields",
        "unsupported_metric",
      ],
      unmapped_keys: ["healthKitIdentifier", "value"],
      candidate_time_fields: ["startDate"],
      candidate_numeric_fields: ["value"],
      source_ids: ["Watch"],
      samples: [
        {
          sample_index: 0,
          reasons: [
            "unsupported_metric",
            "unmapped_sample_fields",
            "rejected_sample",
          ],
          source_id: "Watch",
          missing_time_fields: [],
          missing_value_fields: ["qty"],
          candidate_time_fields: ["startDate"],
          candidate_numeric_fields: ["value"],
        },
      ],
    });
  });

  it("uses category event fallback timestamps for generic quantities", () => {
    expect(
      normalizeBatch({
        metric: "mindful_session",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            endDate: "2024-03-15T08:15:00Z",
            qty: 900,
            rawValue: 0,
            source: "Apple Watch",
          },
        ],
      })[0]?.normalizedSample,
    ).toEqual({
      time: "2024-03-15T08:15:00.000Z",
      metric_name: "mindful_session",
      value: 900,
      unit: "",
      source_id: "Apple Watch",
    });
  });

  it("accepts ECG compatibility payloads without rejected records", () => {
    const result = normalizeBatchWithStats({
      metric: "ecg",
      batch_index: 0,
      total_batches: 1,
      samples: [
        {
          start: "2026-04-10T12:00:00Z",
          end: "2026-04-10T12:00:30Z",
          classification: "sinusRhythm",
          numberOfVoltageMeasurements: 512,
          samplingFrequency: 512,
          averageHeartRate: 72,
        },
      ],
    });

    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({
      recordsReceived: 1,
      recordsAccepted: 0,
      recordsRejected: 0,
      recordsDedupedInBatch: 0,
    });
  });

  it("routes daily quantity metrics into daily_activity", () => {
    expect(
      normalizeBatch({
        metric: "step_count",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            date: "2026-04-10T23:00:00Z",
            qty: 1234.9,
            sourceName: "HealthKit Statistics",
          },
        ],
      })[0],
    ).toMatchObject({
      metric: "step_count",
      normalizedMetric: "daily_activity",
      deviceId: "HealthKit Statistics",
      normalizedSample: {
        date: "2026-04-10",
        steps: 1234,
      },
    });
  });

  it("maps all supported daily quantity metrics into the expected daily_activity fields", () => {
    const cases = [
      {
        metric: "step_count",
        qty: 1234.9,
        expected: { steps: 1234 },
      },
      {
        metric: "distance_walking_running",
        qty: 4567.8,
        expected: { distance_m: 4567.8 },
      },
      {
        metric: "flights_climbed",
        qty: 12.9,
        expected: { floors_climbed: 12 },
      },
      {
        metric: "active_energy_burned",
        qty: 321.5,
        expected: { active_calories: 321.5 },
      },
      {
        metric: "basal_energy_burned",
        qty: 654.25,
        expected: { total_calories: 654.25 },
      },
      {
        metric: "apple_exercise_time",
        qty: 42.8,
        expected: { active_minutes: 42 },
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        normalizeBatch({
          metric: testCase.metric,
          batch_index: 0,
          total_batches: 1,
          samples: [
            {
              date: "2026-04-10T12:00:00Z",
              qty: testCase.qty,
              source: "HealthKit Statistics",
            },
          ],
        })[0],
      ).toMatchObject({
        metric: testCase.metric,
        normalizedMetric: "daily_activity",
        normalizedSample: {
          date: "2026-04-10",
          ...testCase.expected,
        },
      });
    }
  });

  it("keeps non-summary daily metrics in quantity_samples", () => {
    expect(
      normalizeBatch({
        metric: "apple_stand_time",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            date: "2026-04-10T12:00:00Z",
            qty: 42,
            source: "Watch",
          },
        ],
      })[0],
    ).toMatchObject({
      normalizedMetric: "quantity_samples",
      normalizedSample: {
        metric_name: "apple_stand_time",
        value: 42,
      },
    });
  });

  it("normalizes blood oxygen aliases and fractional saturation values", () => {
    expect(
      normalizeBatch({
        metric: "blood_oxygen",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            startDate: "2026-04-10T12:00:00Z",
            oxygenSaturation: 0.973,
            source: "Watch",
          },
        ],
      })[0]?.normalizedSample,
    ).toEqual({
      time: "2026-04-10T12:00:00.000Z",
      spo2_pct: 97.3,
      source_id: "Watch",
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

  it("maps all activity summary field aliases into daily_activity fields", () => {
    const cases = [
      { sample: { steps: 1234 }, expected: { steps: 1234 } },
      { sample: { distance: 4567.8 }, expected: { distance_m: 4567.8 } },
      {
        sample: { flights_climbed: 12.9 },
        expected: { floors_climbed: 12.9 },
      },
      {
        sample: { active_energy: 321.5 },
        expected: { active_calories: 321.5 },
      },
      {
        sample: { activeEnergyBurned: 333.5 },
        expected: { active_calories: 333.5 },
      },
      {
        sample: { basal_energy: 654.25 },
        expected: { total_calories: 654.25 },
      },
      {
        sample: { exercise_minutes: 42 },
        expected: { active_minutes: 42 },
      },
      {
        sample: { appleExerciseTime: 43 },
        expected: { active_minutes: 43 },
      },
      { sample: { stand_hours: 11 }, expected: { stand_hours: 11 } },
      { sample: { appleStandHours: 12 }, expected: { stand_hours: 12 } },
    ] as const;

    for (const testCase of cases) {
      expect(
        normalizeBatch({
          metric: "activity_summaries",
          batch_index: 0,
          total_batches: 1,
          samples: [
            {
              date: "2026-04-10T23:00:00Z",
              ...testCase.sample,
            },
          ],
        })[0]?.normalizedSample,
      ).toEqual({
        date: "2026-04-10",
        ...testCase.expected,
      });
    }
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

  it("normalizes wrist temperature as a body_temperature alias", () => {
    expect(
      normalizeBatch({
        metric: "wrist_temperature",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            date: "2026-04-10T12:00:00Z",
            qty: 32.5,
            device: "Apple Watch",
          },
        ],
      })[0],
    ).toMatchObject({
      normalizedMetric: "body_temperature",
      deviceId: "Apple Watch",
      normalizedSample: {
        time: "2026-04-10T12:00:00.000Z",
        temp_celsius: 32.5,
        source_id: "Apple Watch",
      },
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
      source_id: "HealthSave",
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
      source_id: "HealthSave",
    });
  });

  it("preserves sample-level metric names for blood pressure correlations", () => {
    expect(
      normalizeBatch({
        metric: "blood_pressure",
        batch_index: 0,
        total_batches: 1,
        samples: [
          {
            metric: "blood_pressure_systolic",
            date: "2026-04-10T09:00:00Z",
            qty: 120,
            source: "Monitor",
          },
          {
            metric: "blood_pressure_diastolic",
            date: "2026-04-10T09:00:00Z",
            qty: 80,
            source: "Monitor",
          },
        ],
      }).map((record) => record.normalizedSample.metric_name),
    ).toEqual([
      "blood_pressure_systolic",
      "blood_pressure_diastolic",
    ]);
  });
});

describe("createStatusObservations", () => {
  it("creates public status observations and skips body_temperature", () => {
    const records = normalizeBatch({
      metric: "heart_rate",
      batch_index: 0,
      total_batches: 1,
      samples: [
        { date: "2026-04-10T12:00:00Z", qty: 72, source: "Watch" },
      ],
    }).concat(
      normalizeBatch({
        metric: "wrist_temperature",
        batch_index: 0,
        total_batches: 1,
        samples: [
          { date: "2026-04-10T12:00:00Z", qty: 33.1, source: "Watch" },
        ],
      }),
    );

    expect(createStatusObservations(records)).toEqual([
      {
        statusMetric: "heart_rate",
        deviceId: "Watch",
        observedAt: "2026-04-10T12:00:00.000Z",
      },
    ]);
  });

  it("uses inner quantity metric names when building quantity sample identities", () => {
    const records = normalizeBatch({
      metric: "blood_pressure",
      batch_index: 0,
      total_batches: 1,
      samples: [
        {
          metric: "blood_pressure_systolic",
          date: "2026-04-10T09:00:00Z",
          qty: 120,
          source: "Monitor",
        },
        {
          metric: "blood_pressure_diastolic",
          date: "2026-04-10T09:00:00Z",
          qty: 80,
          source: "Monitor",
        },
      ],
    });

    expect(createStatusObservations(records)).toEqual([
      {
        statusMetric: "quantity_samples",
        deviceId: "Monitor",
        secondaryKey: "blood_pressure_systolic",
        observedAt: "2026-04-10T09:00:00.000Z",
      },
      {
        statusMetric: "quantity_samples",
        deviceId: "Monitor",
        secondaryKey: "blood_pressure_diastolic",
        observedAt: "2026-04-10T09:00:00.000Z",
      },
    ]);
  });
});

describe("resolveDeviceIdentity", () => {
  it("uses source-like aliases and falls back to HealthSave", () => {
    expect(resolveDeviceIdentity({ sourceName: "Apple Watch Ultra" })).toBe(
      "Apple Watch Ultra",
    );
    expect(resolveDeviceIdentity({ deviceName: "Bluetooth Cuff" })).toBe(
      "Bluetooth Cuff",
    );
    expect(resolveDeviceIdentity({})).toBe("HealthSave");
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
