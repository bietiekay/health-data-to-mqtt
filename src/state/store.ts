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
  getCounts(contextName?: string): Promise<StatusCounts>;
  increment(
    counter: StatusCounterKey,
    amount: number,
    contextName?: string,
  ): Promise<void>;
}

export function createEmptyCounts(): StatusCounts {
  return Object.fromEntries(
    statusCounterKeys.map((key) => [key, 0]),
  ) as StatusCounts;
}

export function createMemoryStateStore(
  initialCounts: StatusCounts = createEmptyCounts(),
): StateStore {
  const countsByContext = new Map<string, StatusCounts>([
    ["default", { ...initialCounts }],
  ]);

  function countsForContext(contextName = "default"): StatusCounts {
    const existingCounts = countsByContext.get(contextName);
    if (existingCounts) {
      return existingCounts;
    }

    const counts = createEmptyCounts();
    countsByContext.set(contextName, counts);
    return counts;
  }

  return {
    async getCounts(contextName) {
      return { ...countsForContext(contextName) };
    },

    async increment(counter, amount, contextName) {
      countsForContext(contextName)[counter] += amount;
    },
  };
}
