import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { encodeContextName } from "../storage/raw-batch-storage.js";

export const statusMetricKeys = [
  "heart_rate",
  "hrv",
  "blood_oxygen",
  "daily_activity",
  "sleep_sessions",
  "workouts",
  "quantity_samples",
] as const;

export type StatusMetricKey = (typeof statusMetricKeys)[number];

export interface MetricStatus {
  count: number;
  oldest: string | null;
  newest: string | null;
}

export type StatusSnapshot = Record<StatusMetricKey, MetricStatus>;

export interface StatusObservation {
  statusMetric: StatusMetricKey;
  identityKey: string;
  observedAt: string;
}

export interface ApplyObservationsResult {
  applied: number;
  duplicates: number;
}

export interface StateStore {
  getStatus(contextName?: string): Promise<StatusSnapshot>;
  applyObservations(
    observations: StatusObservation[],
    contextName?: string,
  ): Promise<ApplyObservationsResult>;
}

export function createStateStore(config: AppConfig): StateStore {
  if (config.stateBackend === "memory") {
    return createMemoryStateStore();
  }

  return new FileStateStore(join(config.dataPath, "status"));
}

export function createEmptyStatus(): StatusSnapshot {
  return Object.fromEntries(
    statusMetricKeys.map((key) => [
      key,
      {
        count: 0,
        oldest: null,
        newest: null,
      } satisfies MetricStatus,
    ]),
  ) as StatusSnapshot;
}

export function createMemoryStateStore(
  initialStatus: StatusSnapshot = createEmptyStatus(),
): StateStore {
  const contexts = new Map<string, ContextState>([
    ["default", createContextState(initialStatus)],
  ]);

  function contextForName(contextName = "default"): ContextState {
    const existingContext = contexts.get(contextName);
    if (existingContext) {
      return existingContext;
    }

    const nextContext = createContextState();
    contexts.set(contextName, nextContext);
    return nextContext;
  }

  return {
    async getStatus(contextName) {
      return cloneStatus(contextForName(contextName).status);
    },

    async applyObservations(observations, contextName) {
      return applyObservationsToContext(contextForName(contextName), observations);
    },
  };
}

export class FileStateStore implements StateStore {
  private readonly contexts = new Map<string, ContextState>();
  private readonly loadedContexts = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly basePath: string) {}

  async getStatus(contextName?: string): Promise<StatusSnapshot> {
    const normalizedContextName = normalizeContextName(contextName);
    await this.ensureLoaded(normalizedContextName);
    return cloneStatus(this.contextForName(normalizedContextName).status);
  }

  async applyObservations(
    observations: StatusObservation[],
    contextName?: string,
  ): Promise<ApplyObservationsResult> {
    if (observations.length === 0) {
      return { applied: 0, duplicates: 0 };
    }

    const normalizedContextName = normalizeContextName(contextName);
    return this.enqueue(async () => {
      await this.ensureLoaded(normalizedContextName);
      const context = this.contextForName(normalizedContextName);
      const { result, appliedObservations } = collectAppliedObservations(
        context,
        observations,
      );
      if (result.applied > 0) {
        await this.appendObservations(normalizedContextName, appliedObservations);
      }

      return result;
    });
  }

  private async ensureLoaded(contextName: string): Promise<void> {
    if (this.loadedContexts.has(contextName)) {
      return;
    }

    await this.load(contextName);
    this.loadedContexts.add(contextName);
  }

  private async load(contextName: string): Promise<void> {
    const context = this.contextForName(contextName);
    const filePath = ledgerFilePath(this.basePath, contextName);

    try {
      const content = await readFile(filePath, "utf8");
      for (const observation of parseObservationLines(content)) {
        applyObservation(context, observation);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private contextForName(contextName: string): ContextState {
    const existingContext = this.contexts.get(contextName);
    if (existingContext) {
      return existingContext;
    }

    const nextContext = createContextState();
    this.contexts.set(contextName, nextContext);
    return nextContext;
  }

  private async appendObservations(
    contextName: string,
    observations: StatusObservation[],
  ): Promise<void> {
    const filePath = ledgerFilePath(this.basePath, contextName);
    const lines = observations.map((observation) => `${JSON.stringify(observation)}\n`);

    await mkdir(join(this.basePath, encodeContextName(contextName)), {
      recursive: true,
    });
    await appendFile(filePath, lines.join(""), "utf8");
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const nextOperation = this.operationQueue.then(operation, operation);
    this.operationQueue = nextOperation.then(
      () => undefined,
      () => undefined,
    );
    return nextOperation;
  }
}

interface ContextState {
  status: StatusSnapshot;
  identities: Map<StatusMetricKey, Map<string, string>>;
}

function createContextState(initialStatus?: StatusSnapshot): ContextState {
  return {
    status: cloneStatus(initialStatus ?? createEmptyStatus()),
    identities: new Map(statusMetricKeys.map((key) => [key, new Map()])),
  };
}

function cloneStatus(status: StatusSnapshot): StatusSnapshot {
  return Object.fromEntries(
    statusMetricKeys.map((key) => [key, { ...status[key] }]),
  ) as StatusSnapshot;
}

function normalizeContextName(contextName?: string): string {
  return contextName?.trim() || "default";
}

function applyObservationsToContext(
  context: ContextState,
  observations: StatusObservation[],
): ApplyObservationsResult {
  let applied = 0;
  let duplicates = 0;

  for (const observation of observations) {
    if (applyObservation(context, observation)) {
      applied += 1;
    } else {
      duplicates += 1;
    }
  }

  return { applied, duplicates };
}

function collectAppliedObservations(
  context: ContextState,
  observations: StatusObservation[],
): { result: ApplyObservationsResult; appliedObservations: StatusObservation[] } {
  const appliedObservations: StatusObservation[] = [];
  let duplicates = 0;

  for (const observation of observations) {
    if (applyObservation(context, observation)) {
      appliedObservations.push(observation);
    } else {
      duplicates += 1;
    }
  }

  return {
    result: {
      applied: appliedObservations.length,
      duplicates,
    },
    appliedObservations,
  };
}

function applyObservation(
  context: ContextState,
  observation: StatusObservation,
): boolean {
  const metricIdentities = context.identities.get(observation.statusMetric);
  if (!metricIdentities) {
    return false;
  }

  if (metricIdentities.has(observation.identityKey)) {
    return false;
  }

  metricIdentities.set(observation.identityKey, observation.observedAt);
  updateMetricStatus(context.status[observation.statusMetric], observation.observedAt);
  return true;
}

function updateMetricStatus(metricStatus: MetricStatus, observedAt: string): void {
  metricStatus.count += 1;

  if (metricStatus.oldest === null || observedAt < metricStatus.oldest) {
    metricStatus.oldest = observedAt;
  }

  if (metricStatus.newest === null || observedAt > metricStatus.newest) {
    metricStatus.newest = observedAt;
  }
}

function parseObservationLines(content: string): StatusObservation[] {
  const observations: StatusObservation[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const parsed = JSON.parse(trimmed) as Partial<StatusObservation>;
    if (
      isStatusMetricKey(parsed.statusMetric) &&
      typeof parsed.identityKey === "string" &&
      parsed.identityKey.length > 0 &&
      typeof parsed.observedAt === "string" &&
      parsed.observedAt.length > 0
    ) {
      observations.push({
        statusMetric: parsed.statusMetric,
        identityKey: parsed.identityKey,
        observedAt: parsed.observedAt,
      });
    }
  }

  return observations;
}

function ledgerFilePath(basePath: string, contextName: string): string {
  return join(
    basePath,
    encodeContextName(contextName),
    "observations.ndjson",
  );
}

function isStatusMetricKey(value: unknown): value is StatusMetricKey {
  return typeof value === "string" && statusMetricKeys.includes(value as StatusMetricKey);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
