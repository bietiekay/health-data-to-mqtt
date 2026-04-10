import { z } from "zod";
import type { StatusCounterKey } from "./state/store.js";

export const batchRequestSchema = z.object({
  metric: z.string().default("unknown"),
  batch_index: z.number().int().nonnegative().default(0),
  total_batches: z.number().int().positive().default(1),
  samples: z.array(z.record(z.unknown())).default([]),
});

export type BatchRequest = z.infer<typeof batchRequestSchema>;

const metricCounters: Record<string, StatusCounterKey> = {
  heart_rate: "heart_rate",
  heart_rate_variability: "hrv",
  blood_oxygen: "blood_oxygen",
  activity_summaries: "daily_activity",
  sleep_analysis: "sleep_sessions",
  workouts: "workouts",
};

export function counterForMetric(metric: string): StatusCounterKey {
  return metricCounters[metric] ?? "quantity_samples";
}
