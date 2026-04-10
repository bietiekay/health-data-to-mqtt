export const statusCounterKeys = [
  "heart_rate",
  "hrv",
  "blood_oxygen",
  "daily_activity",
  "sleep_sessions",
  "workouts",
  "quantity_samples",
] as const;

export type StatusCounterKey = (typeof statusCounterKeys)[number];
export type StatusCounts = Record<StatusCounterKey, number>;

export interface StateStore {
  getCounts(): Promise<StatusCounts>;
  increment(counter: StatusCounterKey, amount: number): Promise<void>;
}

export function createEmptyCounts(): StatusCounts {
  return Object.fromEntries(
    statusCounterKeys.map((key) => [key, 0]),
  ) as StatusCounts;
}

export function createMemoryStateStore(initialCounts: StatusCounts = createEmptyCounts()): StateStore {
  const counts: StatusCounts = { ...initialCounts };

  return {
    async getCounts() {
      return { ...counts };
    },

    async increment(counter, amount) {
      counts[counter] += amount;
    },
  };
}
