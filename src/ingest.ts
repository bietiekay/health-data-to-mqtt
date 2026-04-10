import { z } from "zod";
import type { StatusCounterKey } from "./state/store.js";

const sampleSchema = z.preprocess(
  deserializeSampleValue,
  z.record(z.unknown()),
);

const samplesSchema = z.preprocess(
  deserializeSampleArray,
  z.array(sampleSchema).default([]),
);

export const batchRequestSchema = z.preprocess(
  deserializeBatchPayload,
  z.object({
    metric: z.string().default("unknown"),
    batch_index: z.number().int().nonnegative().default(0),
    total_batches: z.number().int().positive().default(1),
    samples: samplesSchema,
  }),
);

export type BatchRequest = z.infer<typeof batchRequestSchema>;

export interface NormalizedRecord {
  metric: string;
  normalizedMetric: string;
  recordIndex: number;
  deviceId: string;
  normalizedSample: Record<string, unknown>;
}

interface DedicatedMetricSpec {
  normalizedMetric: string;
  valueField: string;
  timeFields?: string[];
  valueFields?: string[];
  transformValue?: (value: number) => number;
  defaults?: Record<string, unknown>;
}

const bloodOxygenSpec: DedicatedMetricSpec = {
  normalizedMetric: "blood_oxygen",
  valueField: "spo2_pct",
  valueFields: [
    "qty",
    "spo2_pct",
    "spo2",
    "oxygenSaturation",
    "oxygen_saturation",
    "bloodOxygen",
    "blood_oxygen",
    "percentage",
    "percent",
    "value",
  ],
  transformValue: normalizeOxygenSaturation,
};

const dedicatedMetricSpecs: Record<string, DedicatedMetricSpec> = {
  heart_rate: {
    normalizedMetric: "heart_rate",
    valueField: "bpm",
  },
  heart_rate_variability: {
    normalizedMetric: "hrv",
    valueField: "value_ms",
    defaults: { algorithm: "sdnn" },
  },
  blood_oxygen: bloodOxygenSpec,
  oxygen_saturation: bloodOxygenSpec,
  oxygenSaturation: bloodOxygenSpec,
  body_temperature: {
    normalizedMetric: "body_temperature",
    valueField: "temp_celsius",
  },
};

const metricCounters: Record<string, StatusCounterKey> = {
  heart_rate: "heart_rate",
  heart_rate_variability: "hrv",
  blood_oxygen: "blood_oxygen",
  oxygen_saturation: "blood_oxygen",
  oxygenSaturation: "blood_oxygen",
  activity_summaries: "daily_activity",
  sleep_analysis: "sleep_sessions",
  workout: "workouts",
  workouts: "workouts",
};

export function counterForMetric(metric: string): StatusCounterKey {
  return metricCounters[metric] ?? "quantity_samples";
}

const activityFields: Record<string, string> = {
  steps: "steps",
  distance: "distance_m",
  flights_climbed: "floors_climbed",
  active_energy: "active_calories",
  activeEnergyBurned: "active_calories",
  basal_energy: "total_calories",
  exercise_minutes: "active_minutes",
  appleExerciseTime: "active_minutes",
  stand_hours: "stand_hours",
  appleStandHours: "stand_hours",
};

export function normalizeBatch(batch: BatchRequest): NormalizedRecord[] {
  if (batch.metric === "activity_summaries") {
    return normalizeActivity(batch);
  }

  if (batch.metric === "sleep_analysis") {
    return normalizeSleep(batch);
  }

  if (batch.metric === "workout") {
    return normalizeActiveEnergyQuantity(batch);
  }

  if (batch.metric === "workouts") {
    const workoutRecords = normalizeWorkouts(batch);
    return workoutRecords.length > 0
      ? workoutRecords
      : normalizeActiveEnergyQuantity(batch);
  }

  const dedicatedSpec = dedicatedMetricSpecs[batch.metric];
  if (dedicatedSpec) {
    return normalizeDedicated(batch, dedicatedSpec);
  }

  return normalizeGenericQuantity(batch);
}

function normalizeDedicated(
  batch: BatchRequest,
  spec: DedicatedMetricSpec,
): NormalizedRecord[] {
  const records = batch.samples.flatMap((sample, sampleIndex) => {
    const time = parseTimestamp(
      firstPresent(sample, ...(spec.timeFields ?? ["date", "startDate", "start"])),
    );
    const value = toNumber(firstPresent(sample, ...(spec.valueFields ?? ["qty"])));
    if (!time || value === undefined) {
      return [];
    }

    const normalizedValue = spec.transformValue?.(value) ?? value;
    const normalizedSample = {
      time,
      [spec.valueField]: normalizedValue,
      ...optionalStringField("source_id", sample.source),
      ...spec.defaults,
    };

    return [
      createNormalizedRecord(
        batch.metric,
        spec.normalizedMetric,
        sampleIndex,
        sample,
        normalizedSample,
      ),
    ];
  });

  return dedupeRecords(
    records,
    (record) =>
      `${record.normalizedMetric}:${record.deviceId}:${String(record.normalizedSample.time)}`,
  );
}

function normalizeGenericQuantity(batch: BatchRequest): NormalizedRecord[] {
  const records = batch.samples.flatMap((sample, sampleIndex) => {
    const time = parseTimestamp(sample.date);
    const value = toNumber(sample.qty);
    if (!time || value === undefined) {
      return [];
    }

    return [
      createNormalizedRecord(
        batch.metric,
        "quantity_samples",
        sampleIndex,
        sample,
        {
          time,
          metric_name: batch.metric,
          value,
          unit: getStringValue(sample.unit) ?? "",
          source_id: getStringValue(sample.source) ?? "",
        },
      ),
    ];
  });

  return dedupeRecords(
    records,
    (record) =>
      `${record.normalizedMetric}:${record.metric}:${record.deviceId}:${String(record.normalizedSample.time)}`,
  );
}

function normalizeActiveEnergyQuantity(batch: BatchRequest): NormalizedRecord[] {
  const records = batch.samples.flatMap((sample, sampleIndex) => {
    const time = parseTimestamp(firstPresent(sample, "date", "startDate", "start"));
    const value = toNumber(
      firstPresent(
        sample,
        "activeEnergyBurned",
        "activeEnergy",
        "active_energy",
        "calories",
      ),
    );
    if (!time || value === undefined) {
      return [];
    }

    return [
      createNormalizedRecord(
        batch.metric,
        "quantity_samples",
        sampleIndex,
        sample,
        {
          time,
          metric_name: batch.metric,
          value,
          unit: "kcal",
          source_id: getStringValue(sample.source) ?? "",
        },
      ),
    ];
  });

  return dedupeRecords(
    records,
    (record) =>
      `${record.normalizedMetric}:${record.metric}:${record.deviceId}:${String(record.normalizedSample.time)}`,
  );
}

function normalizeActivity(batch: BatchRequest): NormalizedRecord[] {
  const records = batch.samples.flatMap((sample, sampleIndex) => {
    const activityDate = parseDateValue(sample.date);
    if (!activityDate) {
      return [];
    }

    const normalizedSample: Record<string, unknown> = { date: activityDate };
    for (const [sourceField, normalizedField] of Object.entries(activityFields)) {
      if (Object.hasOwn(sample, sourceField)) {
        const value = toNumber(sample[sourceField]);
        if (value !== undefined) {
          normalizedSample[normalizedField] = value;
        }
      }
    }

    return [
      createNormalizedRecord(
        batch.metric,
        "daily_activity",
        sampleIndex,
        sample,
        normalizedSample,
      ),
    ];
  });

  return dedupeRecords(
    records,
    (record) =>
      `${record.normalizedMetric}:${record.deviceId}:${String(record.normalizedSample.date)}`,
  );
}

function normalizeSleep(batch: BatchRequest): NormalizedRecord[] {
  if (batch.samples.some((sample) => "startDate" in sample || "value" in sample)) {
    return aggregateSleepStages(batch);
  }

  return batch.samples.flatMap((sample, sampleIndex) => {
    const start = parseTimestamp(
      firstPresent(sample, "start_date", "startDate", "date"),
    );
    const end = parseTimestamp(firstPresent(sample, "end_date", "endDate"));
    if (!start || !end) {
      return [];
    }

    return [
      createNormalizedRecord(
        batch.metric,
        "sleep_sessions",
        sampleIndex,
        sample,
        {
          start_time: start,
          end_time: end,
          total_duration_ms: toNumberOrNull(sample.total_duration_ms),
          deep_ms: toNumberOrNull(sample.deep_ms),
          rem_ms: toNumberOrNull(sample.rem_ms),
          light_ms: toNumberOrNull(sample.light_ms ?? sample.core_ms),
          awake_ms: toNumberOrNull(sample.awake_ms),
          respiratory_rate: toNumberOrNull(sample.respiratory_rate),
        },
      ),
    ];
  });
}

function aggregateSleepStages(batch: BatchRequest): NormalizedRecord[] {
  const segments = batch.samples.flatMap((sample, sampleIndex) => {
    const start = parseDateObject(
      firstPresent(sample, "start_date", "startDate", "start", "date"),
    );
    const end = parseDateObject(firstPresent(sample, "end_date", "endDate", "end"));
    if (!start || !end || end <= start) {
      return [];
    }

    return [
      {
        start,
        end,
        sampleIndex,
        deviceId: deviceIdFromSample(sample),
        stage: String(firstPresent(sample, "value", "stage") ?? "")
          .trim()
          .toLowerCase(),
      },
    ];
  });

  if (segments.length === 0) {
    return [];
  }

  segments.sort((left, right) => left.start.getTime() - right.start.getTime());

  const sessions: Array<{
    start: Date;
    end: Date;
    lastEnd: Date;
    firstSampleIndex: number;
    deviceId: string;
    lastStage: string;
    deepMs: number;
    remMs: number;
    lightMs: number;
    awakeMs: number;
  }> = [];
  const gapThresholdMs = 4 * 60 * 60 * 1000;
  let current: (typeof sessions)[number] | undefined;

  for (const segment of segments) {
    if (
      !current ||
      segment.start.getTime() - current.lastEnd.getTime() > gapThresholdMs
    ) {
      current = {
        start: segment.start,
        end: segment.end,
        lastEnd: segment.end,
        firstSampleIndex: segment.sampleIndex,
        deviceId: segment.deviceId,
        lastStage: segment.stage,
        deepMs: 0,
        remMs: 0,
        lightMs: 0,
        awakeMs: 0,
      };
      sessions.push(current);
    } else {
      current.end = maxDate(current.end, segment.end);
      current.lastEnd = maxDate(current.lastEnd, segment.end);
      current.lastStage = segment.stage;
    }

    const durationMs = durationMsBetween(segment.start, segment.end);
    if (segment.stage === "deep") {
      current.deepMs += durationMs;
    } else if (segment.stage === "rem") {
      current.remMs += durationMs;
    } else if (segment.stage === "awake") {
      current.awakeMs += durationMs;
    } else if (
      ["core", "light", "asleep", "asleep unspecified"].includes(segment.stage)
    ) {
      current.lightMs += durationMs;
    }
  }

  return sessions.flatMap((session, index) => {
    const totalDurationMs = session.deepMs + session.remMs + session.lightMs;
    if (totalDurationMs === 0 && session.awakeMs === 0) {
      return [];
    }

    return [
      {
        metric: batch.metric,
        normalizedMetric: "sleep_sessions",
        recordIndex: index,
        deviceId: session.deviceId,
        normalizedSample: {
          start_time: session.start.toISOString(),
          end_time: session.end.toISOString(),
          total_duration_ms: totalDurationMs,
          deep_ms: session.deepMs,
          rem_ms: session.remMs,
          light_ms: session.lightMs,
          awake_ms: session.awakeMs,
          awake: session.lastStage === "awake",
          respiratory_rate: null,
          first_sample_index: session.firstSampleIndex,
        },
      },
    ];
  });
}

function normalizeWorkouts(batch: BatchRequest): NormalizedRecord[] {
  return batch.samples.flatMap((sample, sampleIndex) => {
    const start = parseTimestamp(
      firstPresent(sample, "start_date", "startDate", "start", "date"),
    );
    const end = parseTimestamp(firstPresent(sample, "end_date", "endDate", "end"));
    if (!start || !end) {
      return [];
    }

    const durationMs =
      toNumber(sample.duration_ms) ??
      secondsToMilliseconds(toNumber(sample.duration));

    return [
      createNormalizedRecord(
        batch.metric,
        "workouts",
        sampleIndex,
        sample,
        {
          start_time: start,
          end_time: end,
          sport_type:
            getStringValue(firstPresent(sample, "sport_type", "sportType", "name")) ??
            "unknown",
          duration_ms: durationMs ?? null,
          avg_hr: toNumberOrNull(firstPresent(sample, "avg_hr", "avgHeartRate")),
          max_hr: toNumberOrNull(firstPresent(sample, "max_hr", "maxHeartRate")),
          calories: toNumberOrNull(
            firstPresent(
              sample,
              "calories",
              "activeEnergy",
              "activeEnergyBurned",
            ),
          ),
          distance_m: toNumberOrNull(firstPresent(sample, "distance_m", "distance")),
        },
      ),
    ];
  });
}

function createNormalizedRecord(
  metric: string,
  normalizedMetric: string,
  recordIndex: number,
  sourceSample: Record<string, unknown>,
  normalizedSample: Record<string, unknown>,
): NormalizedRecord {
  return {
    metric,
    normalizedMetric,
    recordIndex,
    deviceId: deviceIdFromSample(sourceSample),
    normalizedSample,
  };
}

export function parseTimestamp(value: unknown): string | undefined {
  return parseDateObject(value)?.toISOString();
}

function parseDateObject(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const input = value.trim();
  if (input.length === 0) {
    return undefined;
  }

  const valueWithTimezone =
    input.includes("T") && !hasExplicitTimezone(input) ? `${input}Z` : input;
  const parsed = new Date(valueWithTimezone);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseDateValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const input = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      return input;
    }
  }

  return parseTimestamp(value)?.slice(0, 10);
}

function hasExplicitTimezone(value: string): boolean {
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function firstPresent(
  sample: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    const value = sample[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function toNumberOrNull(value: unknown): number | null {
  return toNumber(value) ?? null;
}

function normalizeOxygenSaturation(value: number): number {
  return value > 0 && value <= 1 ? value * 100 : value;
}

function secondsToMilliseconds(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : Math.trunc(seconds * 1000);
}

function optionalStringField(
  key: string,
  value: unknown,
): Record<string, string> {
  const stringValue = getStringValue(value);
  return stringValue === undefined ? {} : { [key]: stringValue };
}

function getStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function deviceIdFromSample(sample: Record<string, unknown>): string {
  return (
    getStringValue(sample.device_id) ??
    getStringValue(sample.deviceId) ??
    getStringValue(sample.source_id) ??
    getStringValue(sample.source) ??
    "unknown"
  );
}

function durationMsBetween(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

function maxDate(left: Date, right: Date): Date {
  return left > right ? left : right;
}

function dedupeRecords(
  records: NormalizedRecord[],
  keyForRecord: (record: NormalizedRecord) => string,
): NormalizedRecord[] {
  const seen = new Map<string, NormalizedRecord>();
  for (const record of records) {
    seen.set(keyForRecord(record), record);
  }

  return [...seen.values()];
}

function deserializeBatchPayload(value: unknown): unknown {
  const payload = deserializeJsonString(value);
  if (!isRecord(payload)) {
    return payload;
  }

  const nestedData = deserializeJsonString(payload.data);
  if (
    isRecord(nestedData) &&
    !Object.hasOwn(payload, "samples") &&
    (Object.hasOwn(nestedData, "samples") || Object.hasOwn(nestedData, "metric"))
  ) {
    return { ...payload, ...nestedData };
  }

  if (!Object.hasOwn(payload, "samples")) {
    const samples = payload.data ?? payload.records ?? payload.items;
    if (samples !== undefined) {
      return { ...payload, samples };
    }
  }

  return payload;
}

function deserializeSampleArray(value: unknown): unknown {
  const deserialized = deserializeJsonString(value);

  if (isRecord(deserialized) && Array.isArray(deserialized.samples)) {
    return deserialized.samples;
  }

  return deserialized;
}

function deserializeSampleValue(value: unknown): unknown {
  const deserialized = deserializeJsonString(value);
  if (!isRecord(deserialized)) {
    return deserialized;
  }

  for (const key of ["sample", "data", "payload"]) {
    const nestedValue = deserializeJsonString(deserialized[key]);
    if (isRecord(nestedValue)) {
      const metadata = Object.fromEntries(
        Object.entries(deserialized).filter(([metadataKey]) => metadataKey !== key),
      );
      return {
        ...metadata,
        ...nestedValue,
      };
    }
  }

  return deserialized;
}

function deserializeJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
