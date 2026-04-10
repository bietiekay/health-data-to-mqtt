import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config.js";

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

interface PersistedState {
  version: 1;
  contexts: Record<string, Partial<Record<StatusCounterKey, number>>>;
}

export function createStateStore(config: AppConfig): StateStore {
  if (config.stateBackend === "memory") {
    return createMemoryStateStore();
  }

  return new FileStateStore(join(config.dataPath, "state.json"));
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

export class FileStateStore implements StateStore {
  private countsByContext: Map<string, StatusCounts> | undefined;
  private loadPromise: Promise<void> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getCounts(contextName?: string): Promise<StatusCounts> {
    await this.ensureLoaded();
    return { ...this.countsForContext(contextName) };
  }

  async increment(
    counter: StatusCounterKey,
    amount: number,
    contextName?: string,
  ): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      this.countsForContext(contextName)[counter] += amount;
      await this.persist();
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.countsByContext) {
      return;
    }

    this.loadPromise ??= this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");
      this.countsByContext = parsePersistedState(content);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.countsByContext = new Map([["default", createEmptyCounts()]]);
        return;
      }

      throw error;
    }
  }

  private countsForContext(contextName = "default"): StatusCounts {
    if (!this.countsByContext) {
      throw new Error("State store was used before loading");
    }

    const existingCounts = this.countsByContext.get(contextName);
    if (existingCounts) {
      return existingCounts;
    }

    const counts = createEmptyCounts();
    this.countsByContext.set(contextName, counts);
    return counts;
  }

  private async persist(): Promise<void> {
    if (!this.countsByContext) {
      throw new Error("State store was used before loading");
    }

    const persisted: PersistedState = {
      version: 1,
      contexts: Object.fromEntries(this.countsByContext),
    };
    const content = `${JSON.stringify(persisted, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, this.filePath);
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const nextOperation = this.operationQueue.then(operation, operation);
    this.operationQueue = nextOperation.then(
      () => undefined,
      () => undefined,
    );
    await nextOperation;
  }
}

function parsePersistedState(content: string): Map<string, StatusCounts> {
  const parsed = JSON.parse(content) as Partial<PersistedState>;
  const contexts = parsed.contexts ?? {};
  const countsByContext = new Map<string, StatusCounts>();

  for (const [contextName, counts] of Object.entries(contexts)) {
    countsByContext.set(contextName, normalizeCounts(counts));
  }

  if (!countsByContext.has("default")) {
    countsByContext.set("default", createEmptyCounts());
  }

  return countsByContext;
}

function normalizeCounts(
  counts: Partial<Record<StatusCounterKey, unknown>> | undefined,
): StatusCounts {
  const normalizedCounts = createEmptyCounts();

  for (const key of statusCounterKeys) {
    const value = counts?.[key];
    normalizedCounts[key] =
      typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  return normalizedCounts;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
