import type { NormalizedRecord } from "../ingest.js";

export interface CanonicalMetric {
  id: string;
  display_name: string;
  category: string;
  value_type: "quantity" | "boolean" | "category";
  canonical_unit: string | null;
}

interface RecordMetricSpec extends CanonicalMetric {
  normalizedMetric: string;
  field: string;
}

export interface CanonicalObservation {
  metric: CanonicalMetric;
  t: string;
  value: number | null;
  code: string | null;
  unit: string | null;
}

const dedicatedMetricSpecs: Record<string, RecordMetricSpec> = {
  heart_rate: {
    id: "vital.heart_rate",
    display_name: "Heart Rate",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "count/min",
    normalizedMetric: "heart_rate",
    field: "bpm",
  },
  hrv: {
    id: "vital.hrv",
    display_name: "Heart Rate Variability",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "ms",
    normalizedMetric: "hrv",
    field: "value_ms",
  },
  blood_oxygen: {
    id: "vital.blood_oxygen",
    display_name: "Blood Oxygen",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "%",
    normalizedMetric: "blood_oxygen",
    field: "spo2_pct",
  },
  body_temperature: {
    id: "vital.body_temperature",
    display_name: "Body Temperature",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "degC",
    normalizedMetric: "body_temperature",
    field: "temp_celsius",
  },
};

const activityMetricSpecs: Record<string, Omit<RecordMetricSpec, "normalizedMetric">> = {
  steps: {
    id: "activity.steps",
    display_name: "Steps",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "count",
    field: "steps",
  },
  distance_m: {
    id: "activity.distance_walking_running",
    display_name: "Walking + Running Distance",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "m",
    field: "distance_m",
  },
  floors_climbed: {
    id: "activity.flights_climbed",
    display_name: "Flights Climbed",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "count",
    field: "floors_climbed",
  },
  active_calories: {
    id: "activity.active_energy_burned",
    display_name: "Active Energy Burned",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "kcal",
    field: "active_calories",
  },
  active_calories_goal: {
    id: "activity.active_energy_burned_goal",
    display_name: "Active Energy Burned Goal",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "kcal",
    field: "active_calories_goal",
  },
  total_calories: {
    id: "activity.basal_energy_burned",
    display_name: "Basal Energy Burned",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "kcal",
    field: "total_calories",
  },
  active_minutes: {
    id: "activity.apple_exercise_time",
    display_name: "Exercise Time",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "min",
    field: "active_minutes",
  },
  active_minutes_goal: {
    id: "activity.apple_exercise_time_goal",
    display_name: "Exercise Time Goal",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "min",
    field: "active_minutes_goal",
  },
  stand_hours: {
    id: "activity.stand_hours",
    display_name: "Stand Hours",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "h",
    field: "stand_hours",
  },
  stand_hours_goal: {
    id: "activity.stand_hours_goal",
    display_name: "Stand Hours Goal",
    category: "activity",
    value_type: "quantity",
    canonical_unit: "h",
    field: "stand_hours_goal",
  },
};

const sleepMetricSpecs: Record<string, Omit<RecordMetricSpec, "normalizedMetric">> = {
  total_duration_ms: {
    id: "sleep.total_duration",
    display_name: "Sleep Duration",
    category: "sleep",
    value_type: "quantity",
    canonical_unit: "ms",
    field: "total_duration_ms",
  },
  deep_ms: {
    id: "sleep.deep_duration",
    display_name: "Deep Sleep",
    category: "sleep",
    value_type: "quantity",
    canonical_unit: "ms",
    field: "deep_ms",
  },
  rem_ms: {
    id: "sleep.rem_duration",
    display_name: "REM Sleep",
    category: "sleep",
    value_type: "quantity",
    canonical_unit: "ms",
    field: "rem_ms",
  },
  light_ms: {
    id: "sleep.light_duration",
    display_name: "Light/Core Sleep",
    category: "sleep",
    value_type: "quantity",
    canonical_unit: "ms",
    field: "light_ms",
  },
  awake_ms: {
    id: "sleep.awake_duration",
    display_name: "Awake During Sleep",
    category: "sleep",
    value_type: "quantity",
    canonical_unit: "ms",
    field: "awake_ms",
  },
  awake: {
    id: "sleep.awake",
    display_name: "Awake",
    category: "sleep",
    value_type: "boolean",
    canonical_unit: null,
    field: "awake",
  },
  respiratory_rate: {
    id: "vital.respiratory_rate",
    display_name: "Respiratory Rate",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "count/min",
    field: "respiratory_rate",
  },
};

const workoutMetricSpecs: Record<string, Omit<RecordMetricSpec, "normalizedMetric">> = {
  duration_ms: {
    id: "workout.duration",
    display_name: "Workout Duration",
    category: "workout",
    value_type: "quantity",
    canonical_unit: "ms",
    field: "duration_ms",
  },
  avg_hr: {
    id: "workout.avg_heart_rate",
    display_name: "Workout Average Heart Rate",
    category: "workout",
    value_type: "quantity",
    canonical_unit: "count/min",
    field: "avg_hr",
  },
  max_hr: {
    id: "workout.max_heart_rate",
    display_name: "Workout Max Heart Rate",
    category: "workout",
    value_type: "quantity",
    canonical_unit: "count/min",
    field: "max_hr",
  },
  calories: {
    id: "workout.calories",
    display_name: "Workout Calories",
    category: "workout",
    value_type: "quantity",
    canonical_unit: "kcal",
    field: "calories",
  },
  distance_m: {
    id: "workout.distance",
    display_name: "Workout Distance",
    category: "workout",
    value_type: "quantity",
    canonical_unit: "m",
    field: "distance_m",
  },
};

const quantityMetricOverrides: Record<string, CanonicalMetric> = {
  environmental_audio_exposure: {
    id: "environment.environmental_audio_exposure",
    display_name: "Environmental Audio Exposure",
    category: "environment",
    value_type: "quantity",
    canonical_unit: null,
  },
  physical_effort: {
    id: "activity.physical_effort",
    display_name: "Physical Effort",
    category: "activity",
    value_type: "quantity",
    canonical_unit: null,
  },
  handwashing_event: {
    id: "event.handwashing_event",
    display_name: "Handwashing Event",
    category: "event",
    value_type: "quantity",
    canonical_unit: null,
  },
  resting_heart_rate: {
    id: "vital.resting_heart_rate",
    display_name: "Resting Heart Rate",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "count/min",
  },
  walking_heart_rate_average: {
    id: "vital.walking_heart_rate_average",
    display_name: "Walking Heart Rate Average",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "count/min",
  },
  respiratory_rate: {
    id: "vital.respiratory_rate",
    display_name: "Respiratory Rate",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "count/min",
  },
  blood_pressure_systolic: {
    id: "vital.blood_pressure_systolic",
    display_name: "Blood Pressure Systolic",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "mmHg",
  },
  blood_pressure_diastolic: {
    id: "vital.blood_pressure_diastolic",
    display_name: "Blood Pressure Diastolic",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "mmHg",
  },
  blood_glucose: {
    id: "metabolic.blood_glucose",
    display_name: "Blood Glucose",
    category: "metabolic",
    value_type: "quantity",
    canonical_unit: null,
  },
  walking_speed: {
    id: "mobility.walking_speed",
    display_name: "Walking Speed",
    category: "mobility",
    value_type: "quantity",
    canonical_unit: "m/s",
  },
  walking_step_length: {
    id: "mobility.walking_step_length",
    display_name: "Walking Step Length",
    category: "mobility",
    value_type: "quantity",
    canonical_unit: "m",
  },
  walking_asymmetry: {
    id: "mobility.walking_asymmetry",
    display_name: "Walking Asymmetry",
    category: "mobility",
    value_type: "quantity",
    canonical_unit: null,
  },
  walking_double_support: {
    id: "mobility.walking_double_support",
    display_name: "Walking Double Support",
    category: "mobility",
    value_type: "quantity",
    canonical_unit: null,
  },
  stair_ascent_speed: {
    id: "mobility.stair_ascent_speed",
    display_name: "Stair Ascent Speed",
    category: "mobility",
    value_type: "quantity",
    canonical_unit: null,
  },
  time_in_daylight: {
    id: "environment.time_in_daylight",
    display_name: "Time in Daylight",
    category: "environment",
    value_type: "quantity",
    canonical_unit: null,
  },
  vo2_max: {
    id: "vital.vo2_max",
    display_name: "VO2 Max",
    category: "vital",
    value_type: "quantity",
    canonical_unit: "mL/(kg*min)",
  },
};

export const canonicalMetricCatalog: CanonicalMetric[] = [
  ...Object.values(dedicatedMetricSpecs),
  ...Object.values(activityMetricSpecs).map((metric) => ({
    ...metric,
    normalizedMetric: undefined,
  })),
  ...Object.values(sleepMetricSpecs).map((metric) => ({
    ...metric,
    normalizedMetric: undefined,
  })),
  ...Object.values(workoutMetricSpecs).map((metric) => ({
    ...metric,
    normalizedMetric: undefined,
  })),
  ...Object.values(quantityMetricOverrides),
]
  .map(({ id, display_name, category, value_type, canonical_unit }) => ({
    id,
    display_name,
    category,
    value_type,
    canonical_unit,
  }))
  .sort((left, right) => left.id.localeCompare(right.id));

const metricById = new Map(canonicalMetricCatalog.map((metric) => [metric.id, metric]));

export function getCanonicalMetric(metricId: string): CanonicalMetric | undefined {
  return metricById.get(metricId) ?? dynamicQuantityMetricFromId(metricId);
}

export function canonicalObservationsForRecord(
  record: NormalizedRecord,
): CanonicalObservation[] {
  if (record.normalizedMetric in dedicatedMetricSpecs) {
    const spec = dedicatedMetricSpecs[record.normalizedMetric];
    return observationFromField(record, spec, timeForRecord(record));
  }

  if (record.normalizedMetric === "quantity_samples") {
    const metricName =
      typeof record.normalizedSample.metric_name === "string"
        ? record.normalizedSample.metric_name
        : record.metric;
    const metric = quantityMetricOverrides[metricName] ?? dynamicQuantityMetric(metricName);
    return observationFromValue(
      metric,
      timeForRecord(record),
      record.normalizedSample.value,
      stringOrNull(record.normalizedSample.unit),
    );
  }

  if (record.normalizedMetric === "daily_activity") {
    return observationsFromFieldSpecs(
      record,
      "date",
      activityMetricSpecs,
      "daily_activity",
    );
  }

  if (record.normalizedMetric === "sleep_sessions") {
    return observationsFromFieldSpecs(
      record,
      "start_time",
      sleepMetricSpecs,
      "sleep_sessions",
    );
  }

  if (record.normalizedMetric === "workouts") {
    return observationsFromFieldSpecs(
      record,
      "start_time",
      workoutMetricSpecs,
      "workouts",
    );
  }

  return [];
}

export function metricIdForIncomingQuantity(metricName: string): string {
  return (quantityMetricOverrides[metricName] ?? dynamicQuantityMetric(metricName)).id;
}

function observationsFromFieldSpecs(
  record: NormalizedRecord,
  timeField: string,
  specs: Record<string, Omit<RecordMetricSpec, "normalizedMetric">>,
  normalizedMetric: string,
): CanonicalObservation[] {
  const t = normalizedTime(record.normalizedSample[timeField]);
  if (!t) {
    return [];
  }

  return Object.values(specs).flatMap((spec) =>
    observationFromField(record, { ...spec, normalizedMetric }, t),
  );
}

function observationFromField(
  record: NormalizedRecord,
  spec: RecordMetricSpec,
  t: string | undefined,
): CanonicalObservation[] {
  return observationFromValue(spec, t, record.normalizedSample[spec.field], spec.canonical_unit);
}

function observationFromValue(
  metric: CanonicalMetric,
  t: string | undefined,
  rawValue: unknown,
  unit: string | null,
): CanonicalObservation[] {
  if (!t) {
    return [];
  }

  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return [{ metric, t, value: rawValue, code: null, unit }];
  }

  if (typeof rawValue === "boolean") {
    return [{ metric, t, value: rawValue ? 1 : 0, code: String(rawValue), unit }];
  }

  if (typeof rawValue === "string" && rawValue.trim().length > 0) {
    return [{ metric, t, value: null, code: rawValue.trim(), unit }];
  }

  return [];
}

function timeForRecord(record: NormalizedRecord): string | undefined {
  return (
    normalizedTime(record.normalizedSample.time) ??
    normalizedTime(record.normalizedSample.date) ??
    normalizedTime(record.normalizedSample.start_time)
  );
}

function normalizedTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00Z`;
  }

  return trimmed;
}

function dynamicQuantityMetric(metricName: string): CanonicalMetric {
  const normalizedName = metricName.trim() || "unknown";
  return {
    id: `quantity.${normalizedName}`,
    display_name: titleize(normalizedName),
    category: "quantity",
    value_type: "quantity",
    canonical_unit: null,
  };
}

function dynamicQuantityMetricFromId(metricId: string): CanonicalMetric | undefined {
  if (!metricId.startsWith("quantity.") || metricId.length <= "quantity.".length) {
    return undefined;
  }

  return dynamicQuantityMetric(metricId.slice("quantity.".length));
}

function titleize(value: string): string {
  return value
    .split(/[_\s.-]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
