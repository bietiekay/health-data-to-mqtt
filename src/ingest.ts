import { z } from "zod";
import type {
  StatusMetricKey,
  StatusObservation,
} from "./state/store.js";

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
  z
    .object({
      metric: z.string().default("unknown"),
      batch_index: z.number().int().default(0),
      total_batches: z.number().int().default(1),
      samples: samplesSchema,
    })
    .transform((batch) => ({
      ...batch,
      metric: batch.metric.trim() || "unknown",
    })),
);

export type BatchRequest = z.infer<typeof batchRequestSchema>;

export interface NormalizedRecord {
  metric: string;
  normalizedMetric: string;
  recordIndex: number;
  deviceId: string;
  normalizedSample: Record<string, unknown>;
}

export interface NormalizationStats {
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
  recordsDedupedInBatch: number;
}

export type UnknownHealthDataReason =
  | "unsupported_metric"
  | "unmapped_sample_fields"
  | "rejected_sample";

export interface UnknownHealthDataSampleDiagnostic {
  sample_index: number;
  reasons: UnknownHealthDataReason[];
  source_id: string;
  sample_keys: string[];
  unmapped_keys: string[];
  expected_time_fields: string[];
  expected_value_fields: string[];
  missing_time_fields: string[];
  missing_value_fields: string[];
  candidate_time_fields: string[];
  candidate_numeric_fields: string[];
  candidate_string_fields: string[];
  sample: Record<string, unknown>;
}

export interface UnknownHealthDataDiagnostics {
  schema_version: 1;
  metric: string;
  mapper: string;
  normalized_metric: string | null;
  unsupported_metric: boolean;
  total_samples: number;
  reported_samples: number;
  truncated_samples: number;
  reasons: UnknownHealthDataReason[];
  sample_keys: string[];
  unmapped_keys: string[];
  candidate_time_fields: string[];
  candidate_numeric_fields: string[];
  candidate_string_fields: string[];
  source_ids: string[];
  samples: UnknownHealthDataSampleDiagnostic[];
}

export interface NormalizationResult {
  records: NormalizedRecord[];
  stats: NormalizationStats;
  unknownHealthData: UnknownHealthDataDiagnostics;
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
  wrist_temperature: {
    normalizedMetric: "body_temperature",
    valueField: "temp_celsius",
  },
};

const dailyQuantityMetricSpecs: Record<
  string,
  { field: string; transformValue?: (value: number) => number }
> = {
  step_count: {
    field: "steps",
    transformValue: toInteger,
  },
  distance_walking_running: {
    field: "distance_m",
  },
  flights_climbed: {
    field: "floors_climbed",
    transformValue: toInteger,
  },
  active_energy_burned: {
    field: "active_calories",
  },
  basal_energy_burned: {
    field: "total_calories",
  },
  apple_exercise_time: {
    field: "active_minutes",
    transformValue: toInteger,
  },
};

const publicStatusMetrics = new Set<StatusMetricKey>([
  "heart_rate",
  "hrv",
  "blood_oxygen",
  "daily_activity",
  "sleep_sessions",
  "workouts",
  "quantity_samples",
]);

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

const deviceIdentityFields = [
  "source",
  "source_id",
  "sourceName",
  "device",
  "deviceName",
  "device_id",
  "deviceId",
] as const;

const genericQuantityTimeFields = [
  "date",
  "startDate",
  "start",
  "endDate",
  "end",
] as const;

const genericQuantityValueFields = ["qty"] as const;

const diagnosticSampleLimit = 20;

export function createStatusObservations(
  records: NormalizedRecord[],
): StatusObservation[] {
  return records.flatMap((record) => {
    const statusMetric = publicStatusMetricForRecord(record);
    const observedAt = observedAtForRecord(record);
    const identity = statusIdentityForRecord(record);

    if (!statusMetric || !observedAt || !identity) {
      return [];
    }

    return [
      {
        statusMetric,
        ...identity,
        observedAt,
      },
    ];
  });
}

export function normalizeBatch(batch: BatchRequest): NormalizedRecord[] {
  return normalizeBatchWithStats(batch).records;
}

export function normalizeBatchWithStats(batch: BatchRequest): NormalizationResult {
  const result = normalizeBatchRecords(batch);
  return {
    ...result,
    unknownHealthData: createUnknownHealthDataDiagnostics(batch, result),
  };
}

function normalizeBatchRecords(batch: BatchRequest): NormalizationResult {
  if (batch.metric === "activity_summaries") {
    return normalizeActivity(batch);
  }

  const dailyQuantitySpec = dailyQuantityMetricSpecs[batch.metric];
  if (dailyQuantitySpec) {
    return normalizeDailyQuantity(batch, dailyQuantitySpec);
  }

  if (batch.metric === "sleep_analysis") {
    return normalizeSleep(batch);
  }

  if (batch.metric === "workout") {
    return normalizeActiveEnergyQuantity(batch);
  }

  if (batch.metric === "workouts") {
    const workoutResult = normalizeWorkouts(batch);
    return workoutResult.records.length > 0
      ? workoutResult
      : normalizeActiveEnergyQuantity(batch);
  }

  if (batch.metric === "ecg") {
    return createNormalizationResult(batch, [], batch.samples.length, 0);
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
): NormalizationResult {
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
      source_id: resolveDeviceIdentity(sample),
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
    batch,
    records,
    (record) =>
      `${record.normalizedMetric}:${record.deviceId}:${String(record.normalizedSample.time)}`,
  );
}

function normalizeGenericQuantity(batch: BatchRequest): NormalizationResult {
  const records = batch.samples.flatMap((sample, sampleIndex) => {
    const time = parseTimestamp(
      firstPresent(sample, "date", "startDate", "start", "endDate", "end"),
    );
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
          metric_name: getStringValue(sample.metric) ?? batch.metric,
          value,
          unit: getStringValue(sample.unit) ?? "",
          source_id: resolveDeviceIdentity(sample),
        },
      ),
    ];
  });

  return dedupeRecords(
    batch,
    records,
    (record) =>
      `${record.normalizedMetric}:${String(record.normalizedSample.metric_name)}:${record.deviceId}:${String(record.normalizedSample.time)}`,
  );
}

function normalizeDailyQuantity(
  batch: BatchRequest,
  spec: { field: string; transformValue?: (value: number) => number },
): NormalizationResult {
  const records = batch.samples.flatMap((sample, sampleIndex) => {
    const activityDate = parseDateValue(sample.date);
    const rawValue = toNumber(sample.qty);
    if (!activityDate || rawValue === undefined) {
      return [];
    }

    return [
      createNormalizedRecord(
        batch.metric,
        "daily_activity",
        sampleIndex,
        sample,
        {
          date: activityDate,
          [spec.field]: spec.transformValue?.(rawValue) ?? rawValue,
        },
      ),
    ];
  });

  return dedupeRecords(
    batch,
    records,
    (record) =>
      `${record.normalizedMetric}:${record.deviceId}:${String(record.normalizedSample.date)}`,
  );
}

function normalizeActiveEnergyQuantity(batch: BatchRequest): NormalizationResult {
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
          source_id: resolveDeviceIdentity(sample),
        },
      ),
    ];
  });

  return dedupeRecords(
    batch,
    records,
    (record) =>
      `${record.normalizedMetric}:${record.metric}:${record.deviceId}:${String(record.normalizedSample.time)}`,
  );
}

function normalizeActivity(batch: BatchRequest): NormalizationResult {
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
    batch,
    records,
    (record) =>
      `${record.normalizedMetric}:${record.deviceId}:${String(record.normalizedSample.date)}`,
  );
}

function normalizeSleep(batch: BatchRequest): NormalizationResult {
  if (batch.samples.some((sample) => "startDate" in sample || "value" in sample)) {
    return aggregateSleepStages(batch);
  }

  const records = batch.samples.flatMap((sample, sampleIndex) => {
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

  return dedupeRecords(
    batch,
    records,
    (record) =>
      `${record.normalizedMetric}:${record.deviceId}:${String(record.normalizedSample.start_time)}`,
  );
}

function aggregateSleepStages(batch: BatchRequest): NormalizationResult {
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
    return createNormalizationResult(batch, [], 0, 0);
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

  const records = sessions.flatMap((session, index) => {
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

  return createNormalizationResult(batch, records, segments.length, 0);
}

function normalizeWorkouts(batch: BatchRequest): NormalizationResult {
  const records = batch.samples.flatMap((sample, sampleIndex) => {
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

  return dedupeRecords(
    batch,
    records,
    (record) =>
      `${record.normalizedMetric}:${record.deviceId}:${String(record.normalizedSample.start_time)}`,
  );
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

export function resolveDeviceIdentity(sample: Record<string, unknown>): string {
  return (
    getStringValue(sample.source) ??
    getStringValue(sample.source_id) ??
    getStringValue(sample.sourceName) ??
    getStringValue(sample.device) ??
    getStringValue(sample.deviceName) ??
    getStringValue(sample.device_id) ??
    getStringValue(sample.deviceId) ??
    "HealthSave"
  );
}

function deviceIdFromSample(sample: Record<string, unknown>): string {
  return resolveDeviceIdentity(sample);
}

function publicStatusMetricForRecord(
  record: NormalizedRecord,
): StatusMetricKey | undefined {
  return publicStatusMetrics.has(record.normalizedMetric as StatusMetricKey)
    ? (record.normalizedMetric as StatusMetricKey)
    : undefined;
}

function observedAtForRecord(record: NormalizedRecord): string | undefined {
  if (
    record.normalizedMetric === "heart_rate" ||
    record.normalizedMetric === "hrv" ||
    record.normalizedMetric === "blood_oxygen" ||
    record.normalizedMetric === "quantity_samples"
  ) {
    return getStringValue(record.normalizedSample.time);
  }

  if (record.normalizedMetric === "daily_activity") {
    return getStringValue(record.normalizedSample.date);
  }

  if (
    record.normalizedMetric === "sleep_sessions" ||
    record.normalizedMetric === "workouts"
  ) {
    return getStringValue(record.normalizedSample.start_time);
  }

  return undefined;
}

function statusIdentityForRecord(
  record: NormalizedRecord,
): Pick<StatusObservation, "deviceId" | "secondaryKey"> | undefined {
  if (
    record.normalizedMetric === "heart_rate" ||
    record.normalizedMetric === "hrv" ||
    record.normalizedMetric === "blood_oxygen"
  ) {
    const time = getStringValue(record.normalizedSample.time);
    return time ? { deviceId: record.deviceId } : undefined;
  }

  if (record.normalizedMetric === "daily_activity") {
    const date = getStringValue(record.normalizedSample.date);
    return date ? { deviceId: record.deviceId } : undefined;
  }

  if (
    record.normalizedMetric === "sleep_sessions" ||
    record.normalizedMetric === "workouts"
  ) {
    const startTime = getStringValue(record.normalizedSample.start_time);
    return startTime ? { deviceId: record.deviceId } : undefined;
  }

  if (record.normalizedMetric === "quantity_samples") {
    const time = getStringValue(record.normalizedSample.time);
    const metricName = getStringValue(record.normalizedSample.metric_name);
    return time && metricName
      ? { deviceId: record.deviceId, secondaryKey: metricName }
      : undefined;
  }

  return undefined;
}

function toInteger(value: number): number {
  return Math.trunc(value);
}

function durationMsBetween(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

function maxDate(left: Date, right: Date): Date {
  return left > right ? left : right;
}

function dedupeRecords(
  batch: BatchRequest,
  records: NormalizedRecord[],
  keyForRecord: (record: NormalizedRecord) => string,
): NormalizationResult {
  const seen = new Map<string, NormalizedRecord>();
  for (const record of records) {
    seen.set(keyForRecord(record), record);
  }

  const dedupedRecords = [...seen.values()];
  return createNormalizationResult(
    batch,
    dedupedRecords,
    records.length,
    records.length - dedupedRecords.length,
  );
}

function createNormalizationResult(
  batch: BatchRequest,
  records: NormalizedRecord[],
  acceptedBeforeDedupe: number,
  recordsDedupedInBatch: number,
): NormalizationResult {
  return {
    records,
    stats: {
      recordsReceived: batch.samples.length,
      recordsAccepted: records.length,
      recordsRejected: Math.max(0, batch.samples.length - acceptedBeforeDedupe),
      recordsDedupedInBatch,
    },
    unknownHealthData: createEmptyUnknownHealthDataDiagnostics(batch),
  };
}

interface DiagnosticProfile {
  mapper: string;
  normalizedMetric: string | null;
  unsupportedMetric: boolean;
  knownFields: string[];
  timeFields: string[];
  valueFields: string[];
  isRejected(sample: Record<string, unknown>): boolean;
}

function createUnknownHealthDataDiagnostics(
  batch: BatchRequest,
  result: Pick<NormalizationResult, "records">,
): UnknownHealthDataDiagnostics {
  const profile = diagnosticProfileForBatch(batch, result);
  const samples: UnknownHealthDataSampleDiagnostic[] = [];
  const reasons = new Set<UnknownHealthDataReason>();
  const sampleKeys = new Set<string>();
  const unmappedKeys = new Set<string>();
  const candidateTimeFields = new Set<string>();
  const candidateNumericFields = new Set<string>();
  const candidateStringFields = new Set<string>();
  const sourceIds = new Set<string>();
  let totalSamples = 0;

  for (const [sampleIndex, sample] of batch.samples.entries()) {
    const knownFields = new Set(profile.knownFields);
    const currentSampleKeys = Object.keys(sample).sort();
    const currentUnmappedKeys = currentSampleKeys.filter(
      (key) => !knownFields.has(key),
    );
    const currentCandidateTimeFields = fieldsMatching(sample, parseTimestamp);
    const currentCandidateNumericFields = fieldsMatching(sample, toNumber);
    const currentCandidateStringFields = fieldsMatching(sample, getStringValue);
    const missingTimeFields =
      profile.timeFields.length > 0 && !hasAnyTimeValue(sample, profile.timeFields)
        ? profile.timeFields
        : [];
    const missingValueFields =
      profile.valueFields.length > 0 &&
      !hasAnyNumericValue(sample, profile.valueFields)
        ? profile.valueFields
        : [];
    const sampleReasons: UnknownHealthDataReason[] = [];

    if (profile.unsupportedMetric) {
      sampleReasons.push("unsupported_metric");
    }

    if (currentUnmappedKeys.length > 0) {
      sampleReasons.push("unmapped_sample_fields");
    }

    if (profile.isRejected(sample)) {
      sampleReasons.push("rejected_sample");
    }

    if (sampleReasons.length === 0) {
      continue;
    }

    totalSamples += 1;
    for (const reason of sampleReasons) {
      reasons.add(reason);
    }
    for (const key of currentSampleKeys) {
      sampleKeys.add(key);
    }
    for (const key of currentUnmappedKeys) {
      unmappedKeys.add(key);
    }
    for (const key of currentCandidateTimeFields) {
      candidateTimeFields.add(key);
    }
    for (const key of currentCandidateNumericFields) {
      candidateNumericFields.add(key);
    }
    for (const key of currentCandidateStringFields) {
      candidateStringFields.add(key);
    }
    sourceIds.add(resolveDeviceIdentity(sample));

    if (samples.length >= diagnosticSampleLimit) {
      continue;
    }

    samples.push({
      sample_index: sampleIndex,
      reasons: sampleReasons,
      source_id: resolveDeviceIdentity(sample),
      sample_keys: currentSampleKeys,
      unmapped_keys: currentUnmappedKeys,
      expected_time_fields: profile.timeFields,
      expected_value_fields: profile.valueFields,
      missing_time_fields: missingTimeFields,
      missing_value_fields: missingValueFields,
      candidate_time_fields: currentCandidateTimeFields,
      candidate_numeric_fields: currentCandidateNumericFields,
      candidate_string_fields: currentCandidateStringFields,
      sample,
    });
  }

  return {
    schema_version: 1,
    metric: batch.metric,
    mapper: profile.mapper,
    normalized_metric: profile.normalizedMetric,
    unsupported_metric: profile.unsupportedMetric,
    total_samples: totalSamples,
    reported_samples: samples.length,
    truncated_samples: Math.max(0, totalSamples - samples.length),
    reasons: [...reasons].sort(),
    sample_keys: [...sampleKeys].sort(),
    unmapped_keys: [...unmappedKeys].sort(),
    candidate_time_fields: [...candidateTimeFields].sort(),
    candidate_numeric_fields: [...candidateNumericFields].sort(),
    candidate_string_fields: [...candidateStringFields].sort(),
    source_ids: [...sourceIds].sort(),
    samples,
  };
}

function createEmptyUnknownHealthDataDiagnostics(
  batch: BatchRequest,
): UnknownHealthDataDiagnostics {
  return {
    schema_version: 1,
    metric: batch.metric,
    mapper: "unknown",
    normalized_metric: null,
    unsupported_metric: false,
    total_samples: 0,
    reported_samples: 0,
    truncated_samples: 0,
    reasons: [],
    sample_keys: [],
    unmapped_keys: [],
    candidate_time_fields: [],
    candidate_numeric_fields: [],
    candidate_string_fields: [],
    source_ids: [],
    samples: [],
  };
}

function diagnosticProfileForBatch(
  batch: BatchRequest,
  result: Pick<NormalizationResult, "records">,
): DiagnosticProfile {
  if (batch.metric === "activity_summaries") {
    return {
      mapper: "activity_summaries",
      normalizedMetric: "daily_activity",
      unsupportedMetric: false,
      knownFields: knownSampleFields(["date", ...Object.keys(activityFields)]),
      timeFields: ["date"],
      valueFields: [],
      isRejected: (sample) => parseDateValue(sample.date) === undefined,
    };
  }

  const dailyQuantitySpec = dailyQuantityMetricSpecs[batch.metric];
  if (dailyQuantitySpec) {
    return {
      mapper: "daily_quantity",
      normalizedMetric: "daily_activity",
      unsupportedMetric: false,
      knownFields: knownSampleFields(["date", "qty"]),
      timeFields: ["date"],
      valueFields: ["qty"],
      isRejected: (sample) =>
        parseDateValue(sample.date) === undefined ||
        toNumber(sample.qty) === undefined,
    };
  }

  if (batch.metric === "sleep_analysis") {
    return sleepDiagnosticProfile(batch);
  }

  if (batch.metric === "workout") {
    return activeEnergyDiagnosticProfile();
  }

  if (batch.metric === "workouts") {
    const normalizedMetric = result.records.some(
      (record) => record.normalizedMetric === "workouts",
    )
      ? "workouts"
      : "quantity_samples";
    const sessionProfile = workoutsDiagnosticProfile(normalizedMetric);
    return {
      ...sessionProfile,
      isRejected: (sample) =>
        sessionProfile.isRejected(sample) &&
        activeEnergyDiagnosticProfile().isRejected(sample),
    };
  }

  if (batch.metric === "ecg") {
    return {
      mapper: "ecg_compatibility",
      normalizedMetric: null,
      unsupportedMetric: false,
      knownFields: knownSampleFields([
        "start",
        "startDate",
        "date",
        "end",
        "endDate",
        "classification",
        "numberOfVoltageMeasurements",
        "samplingFrequency",
        "averageHeartRate",
      ]),
      timeFields: [],
      valueFields: [],
      isRejected: () => false,
    };
  }

  const dedicatedSpec = dedicatedMetricSpecs[batch.metric];
  if (dedicatedSpec) {
    const timeFields = dedicatedSpec.timeFields ?? ["date", "startDate", "start"];
    const valueFields = dedicatedSpec.valueFields ?? ["qty"];
    return {
      mapper: "dedicated_metric",
      normalizedMetric: dedicatedSpec.normalizedMetric,
      unsupportedMetric: false,
      knownFields: knownSampleFields([...timeFields, ...valueFields]),
      timeFields,
      valueFields,
      isRejected: (sample) =>
        parseTimestamp(firstPresent(sample, ...timeFields)) === undefined ||
        toNumber(firstPresent(sample, ...valueFields)) === undefined,
    };
  }

  return {
    mapper: "generic_quantity_fallback",
    normalizedMetric: "quantity_samples",
    unsupportedMetric: true,
    knownFields: knownSampleFields([
      ...genericQuantityTimeFields,
      ...genericQuantityValueFields,
      "metric",
      "unit",
    ]),
    timeFields: [...genericQuantityTimeFields],
    valueFields: [...genericQuantityValueFields],
    isRejected: (sample) =>
      parseTimestamp(firstPresent(sample, ...genericQuantityTimeFields)) ===
        undefined || toNumber(firstPresent(sample, ...genericQuantityValueFields)) === undefined,
  };
}

function sleepDiagnosticProfile(batch: BatchRequest): DiagnosticProfile {
  if (batch.samples.some((sample) => "startDate" in sample || "value" in sample)) {
    const timeFields = ["start_date", "startDate", "start", "date"];
    const endFields = ["end_date", "endDate", "end"];
    return {
      mapper: "sleep_stage_aggregation",
      normalizedMetric: "sleep_sessions",
      unsupportedMetric: false,
      knownFields: knownSampleFields([...timeFields, ...endFields, "value", "stage"]),
      timeFields: [...timeFields, ...endFields],
      valueFields: [],
      isRejected: (sample) => {
        const start = parseDateObject(firstPresent(sample, ...timeFields));
        const end = parseDateObject(firstPresent(sample, ...endFields));
        return !start || !end || end <= start;
      },
    };
  }

  const startFields = ["start_date", "startDate", "date"];
  const endFields = ["end_date", "endDate"];
  return {
    mapper: "sleep_session",
    normalizedMetric: "sleep_sessions",
    unsupportedMetric: false,
    knownFields: knownSampleFields([
      ...startFields,
      ...endFields,
      "total_duration_ms",
      "deep_ms",
      "rem_ms",
      "light_ms",
      "core_ms",
      "awake_ms",
      "respiratory_rate",
    ]),
    timeFields: [...startFields, ...endFields],
    valueFields: [],
    isRejected: (sample) =>
      parseTimestamp(firstPresent(sample, ...startFields)) === undefined ||
      parseTimestamp(firstPresent(sample, ...endFields)) === undefined,
  };
}

function workoutsDiagnosticProfile(normalizedMetric: string): DiagnosticProfile {
  const startFields = ["start_date", "startDate", "start", "date"];
  const endFields = ["end_date", "endDate", "end"];
  return {
    mapper: "workouts",
    normalizedMetric,
    unsupportedMetric: false,
    knownFields: knownSampleFields([
      ...startFields,
      ...endFields,
      "sport_type",
      "sportType",
      "name",
      "duration_ms",
      "duration",
      "avg_hr",
      "avgHeartRate",
      "max_hr",
      "maxHeartRate",
      "calories",
      "activeEnergy",
      "activeEnergyBurned",
      "distance_m",
      "distance",
      "active_energy",
    ]),
    timeFields: [...startFields, ...endFields],
    valueFields: [],
    isRejected: (sample) =>
      parseTimestamp(firstPresent(sample, ...startFields)) === undefined ||
      parseTimestamp(firstPresent(sample, ...endFields)) === undefined,
  };
}

function activeEnergyDiagnosticProfile(): DiagnosticProfile {
  const timeFields = ["date", "startDate", "start"];
  const valueFields = [
    "activeEnergyBurned",
    "activeEnergy",
    "active_energy",
    "calories",
  ];
  return {
    mapper: "active_energy_quantity",
    normalizedMetric: "quantity_samples",
    unsupportedMetric: false,
    knownFields: knownSampleFields([
      ...timeFields,
      ...valueFields,
      "appleExerciseTime",
      "appleStandHours",
      "metric",
      "unit",
    ]),
    timeFields,
    valueFields,
    isRejected: (sample) =>
      parseTimestamp(firstPresent(sample, ...timeFields)) === undefined ||
      toNumber(firstPresent(sample, ...valueFields)) === undefined,
  };
}

function knownSampleFields(fields: string[]): string[] {
  return [...new Set([...fields, ...deviceIdentityFields])].sort();
}

function fieldsMatching(
  sample: Record<string, unknown>,
  predicate: (value: unknown) => unknown,
): string[] {
  return Object.keys(sample)
    .filter((key) => predicate(sample[key]) !== undefined)
    .sort();
}

function hasAnyTimeValue(
  sample: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.some((field) => parseTimestamp(sample[field]) !== undefined);
}

function hasAnyNumericValue(
  sample: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.some((field) => toNumber(sample[field]) !== undefined);
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
