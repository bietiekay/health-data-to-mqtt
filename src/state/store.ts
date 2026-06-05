import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config.js";

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
  deviceId: string;
  secondaryKey?: string;
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
  isReady(): boolean;
  close(): Promise<void>;
}

export interface StateStoreLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  info(message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  warn(message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
  error(message: string): void;
}

export function createStateStore(
  config: AppConfig,
  logger: StateStoreLogger = noopLogger,
): StateStore {
  if (config.stateBackend === "memory") {
    logger.info({ state_backend: "memory" }, "selected state backend");
    return createMemoryStateStore();
  }

  logger.info({ state_backend: "file" }, "selected state backend");
  return new SQLiteStateStore(join(config.dataPath, "status"), logger);
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

    isReady() {
      return true;
    },

    async close() {
      return undefined;
    },
  };
}

export class SQLiteStateStore implements StateStore {
  private readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly selectContextIdStatement: StatementSync;
  private readonly insertContextStatement: StatementSync;
  private readonly selectDeviceIdStatement: StatementSync;
  private readonly insertDeviceStatement: StatementSync;
  private readonly selectSecondaryKeyIdStatement: StatementSync;
  private readonly insertSecondaryKeyStatement: StatementSync;
  private readonly insertObservationStatement: StatementSync;
  private readonly upsertAggregateStatement: StatementSync;
  private readonly selectStatusStatement: StatementSync;
  private readonly selectMigrationStatement: StatementSync;
  private readonly insertMigrationStatement: StatementSync;
  private readonly contextIds = new Map<string, number>();
  private readonly deviceIds = new Map<string, number>();
  private readonly secondaryKeyIds = new Map<string, number>([["", 0]]);
  private operationQueue: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(
    private readonly basePath: string,
    private readonly logger: StateStoreLogger = noopLogger,
  ) {
    const startedAt = Date.now();
    this.databasePath = join(basePath, "status.sqlite");
    mkdirSync(basePath, { recursive: true });
    this.logger.info(
      { database_path: this.databasePath },
      "initializing sqlite status store",
    );
    this.db = new DatabaseSync(this.databasePath, {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
    });

    this.logger.info(
      { database_path: this.databasePath },
      "initializing sqlite status schema",
    );
    this.initializeDatabase();
    this.logger.info(
      { database_path: this.databasePath },
      "initialized sqlite status schema",
    );

    this.selectContextIdStatement = this.db.prepare(
      "SELECT id FROM contexts WHERE name = ?",
    );
    this.insertContextStatement = this.db.prepare(
      "INSERT OR IGNORE INTO contexts (name) VALUES (?)",
    );
    this.selectDeviceIdStatement = this.db.prepare(
      "SELECT id FROM devices WHERE value = ?",
    );
    this.insertDeviceStatement = this.db.prepare(
      "INSERT OR IGNORE INTO devices (value) VALUES (?)",
    );
    this.selectSecondaryKeyIdStatement = this.db.prepare(
      "SELECT id FROM secondary_keys WHERE value = ?",
    );
    this.insertSecondaryKeyStatement = this.db.prepare(
      "INSERT OR IGNORE INTO secondary_keys (value) VALUES (?)",
    );
    this.insertObservationStatement = this.db.prepare(`
      INSERT OR IGNORE INTO observations (
        context_id,
        status_metric,
        device_id,
        secondary_key_id,
        observed_at
      )
      VALUES (?, ?, ?, ?, ?)
    `);
    this.upsertAggregateStatement = this.db.prepare(`
      INSERT INTO status_aggregates (
        context_id,
        status_metric,
        count,
        oldest,
        newest
      )
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(context_id, status_metric)
      DO UPDATE SET
        count = count + 1,
        oldest = CASE
          WHEN excluded.oldest < status_aggregates.oldest THEN excluded.oldest
          ELSE status_aggregates.oldest
        END,
        newest = CASE
          WHEN excluded.newest > status_aggregates.newest THEN excluded.newest
          ELSE status_aggregates.newest
        END
    `);
    this.selectStatusStatement = this.db.prepare(`
      SELECT status_metric, count, oldest, newest
      FROM status_aggregates
      WHERE context_id = ?
    `);
    this.selectMigrationStatement = this.db.prepare(
      "SELECT name FROM schema_migrations WHERE name = ?",
    );
    this.insertMigrationStatement = this.db.prepare(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
    );

    try {
      this.migrateLegacyLedgers();
      this.ready = true;
      this.logger.info(
        {
          database_path: this.databasePath,
          elapsed_ms: Date.now() - startedAt,
        },
        "sqlite status store ready",
      );
    } catch (error) {
      this.logger.error(
        {
          database_path: this.databasePath,
          phase: "legacy_migration",
          error: error instanceof Error ? error.message : String(error),
        },
        "failed to initialize sqlite status store",
      );
      this.closeSync();
      throw error;
    }
  }

  async getStatus(contextName?: string): Promise<StatusSnapshot> {
    this.assertReady();
    const contextId = this.getOrCreateContextId(normalizeContextName(contextName));
    const status = createEmptyStatus();

    for (const row of this.selectStatusStatement.all(contextId)) {
      if (!isStatusMetricKey(row.status_metric)) {
        continue;
      }

      status[row.status_metric] = {
        count: numberFromSqlValue(row.count),
        oldest: stringOrNullFromSqlValue(row.oldest),
        newest: stringOrNullFromSqlValue(row.newest),
      };
    }

    return status;
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
      this.assertReady();
      return this.withTransaction(() =>
        this.applyObservationsInTransaction(observations, normalizedContextName),
      );
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  async close(): Promise<void> {
    this.closeSync();
  }

  private initializeDatabase(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS contexts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS secondary_keys (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL UNIQUE
      ) STRICT;

      INSERT OR IGNORE INTO secondary_keys (id, value) VALUES (0, '');

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY,
        context_id INTEGER NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        status_metric TEXT NOT NULL,
        device_id INTEGER NOT NULL REFERENCES devices(id),
        secondary_key_id INTEGER NOT NULL REFERENCES secondary_keys(id),
        observed_at TEXT NOT NULL,
        CHECK (
          status_metric IN (
            'heart_rate',
            'hrv',
            'blood_oxygen',
            'daily_activity',
            'sleep_sessions',
            'workouts',
            'quantity_samples'
          )
        ),
        UNIQUE (
          context_id,
          status_metric,
          device_id,
          secondary_key_id,
          observed_at
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS observations_context_metric_idx
        ON observations (context_id, status_metric);

      CREATE TABLE IF NOT EXISTS status_aggregates (
        context_id INTEGER NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
        status_metric TEXT NOT NULL,
        count INTEGER NOT NULL,
        oldest TEXT NOT NULL,
        newest TEXT NOT NULL,
        PRIMARY KEY (context_id, status_metric),
        CHECK (count > 0),
        CHECK (
          status_metric IN (
            'heart_rate',
            'hrv',
            'blood_oxygen',
            'daily_activity',
            'sleep_sessions',
            'workouts',
            'quantity_samples'
          )
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  private migrateLegacyLedgers(): void {
    const migrationStartedAt = Date.now();
    if (this.selectMigrationStatement.get(legacyMigrationName)) {
      this.logger.info(
        {
          database_path: this.databasePath,
          migration: legacyMigrationName,
        },
        "sqlite status legacy migration skipped",
      );
      return;
    }

    this.logger.info(
      {
        database_path: this.databasePath,
        migration: legacyMigrationName,
      },
      "sqlite status legacy migration needed",
    );
    this.logger.info(
      {
        database_path: this.databasePath,
        migration: legacyMigrationName,
      },
      "starting sqlite status legacy migration",
    );

    const summary: LegacyMigrationSummary = {
      contexts: 0,
      scanned: 0,
      inserted: 0,
      duplicates: 0,
      skipped: 0,
      renamed: 0,
    };
    const ledgersToRename: string[] = [];

    this.withTransaction(() => {
      for (const contextDirectory of legacyContextDirectories(this.basePath)) {
        const contextName = decodeContextName(contextDirectory.name);
        const ledgerPath = join(contextDirectory.path, "observations.ndjson");
        if (!existsSync(ledgerPath)) {
          continue;
        }

        summary.contexts += 1;
        const contextSummary = this.migrateLegacyLedger(contextName, ledgerPath);
        summary.scanned += contextSummary.scanned;
        summary.inserted += contextSummary.inserted;
        summary.duplicates += contextSummary.duplicates;
        summary.skipped += contextSummary.skipped;
        ledgersToRename.push(ledgerPath);
      }

    });

    for (const ledgerPath of ledgersToRename) {
      if (this.renameLegacyLedger(ledgerPath)) {
        summary.renamed += 1;
      }
    }

    this.withTransaction(() => {
      this.insertMigrationStatement.run(
        legacyMigrationName,
        new Date().toISOString(),
      );
    });

    this.logger.info(
      {
        database_path: this.databasePath,
        migration: legacyMigrationName,
        contexts: summary.contexts,
        scanned_rows: summary.scanned,
        inserted_rows: summary.inserted,
        duplicate_rows: summary.duplicates,
        skipped_rows: summary.skipped,
        renamed_ledgers: summary.renamed,
        elapsed_ms: Date.now() - migrationStartedAt,
        migration_marker_written: true,
      },
      "finished sqlite status legacy migration",
    );
  }

  private migrateLegacyLedger(
    contextName: string,
    ledgerPath: string,
  ): LegacyMigrationSummary {
    const startedAt = Date.now();
    const summary: LegacyMigrationSummary = {
      contexts: 1,
      scanned: 0,
      inserted: 0,
      duplicates: 0,
      skipped: 0,
      renamed: 0,
    };
    const content = readFileSync(ledgerPath, "utf8");

    for (const [index, line] of content.split("\n").entries()) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      summary.scanned += 1;
      const parsed = parseLegacyObservationLine(trimmed);
      if (!parsed.ok) {
        summary.skipped += 1;
        this.logSkippedLegacyRow(contextName, ledgerPath, index + 1, parsed);
        continue;
      }

      const observation = legacyObservationToStructuredObservation(parsed.value);
      if (!observation.ok) {
        summary.skipped += 1;
        this.logSkippedLegacyRow(contextName, ledgerPath, index + 1, {
          ok: false,
          reason: observation.reason,
          statusMetric: parsed.value.statusMetric,
        });
        continue;
      }

      const result = this.insertObservation(contextName, observation.value);
      if (result) {
        summary.inserted += 1;
      } else {
        summary.duplicates += 1;
      }
    }

    this.logger.info(
      {
        context: contextName,
        legacy_ledger_path: ledgerPath,
        scanned_rows: summary.scanned,
        inserted_rows: summary.inserted,
        duplicate_rows: summary.duplicates,
        skipped_rows: summary.skipped,
        elapsed_ms: Date.now() - startedAt,
      },
      "migrated sqlite status legacy context",
    );

    return summary;
  }

  private renameLegacyLedger(ledgerPath: string): boolean {
    if (!existsSync(ledgerPath)) {
      return false;
    }

    const archivedPath = archivedLegacyLedgerPath(ledgerPath);
    renameSync(ledgerPath, archivedPath);
    this.logger.info(
      {
        legacy_ledger_path: ledgerPath,
        archived_legacy_ledger_path: archivedPath,
      },
      "renamed migrated sqlite status legacy ledger",
    );
    return true;
  }

  private logSkippedLegacyRow(
    contextName: string,
    ledgerPath: string,
    lineNumber: number,
    result: FailedLegacyObservationParse,
  ): void {
    this.logger.warn(
      {
        context: contextName,
        legacy_ledger_path: ledgerPath,
        line_number: lineNumber,
        reason: result.reason,
        status_metric: result.statusMetric,
      },
      "skipped malformed sqlite status legacy row",
    );
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const nextOperation = this.operationQueue.then(operation, operation);
    this.operationQueue = nextOperation.then(
      () => undefined,
      () => undefined,
    );
    return nextOperation;
  }

  private applyObservationsInTransaction(
    observations: StatusObservation[],
    contextName: string,
  ): ApplyObservationsResult {
    let applied = 0;
    let duplicates = 0;

    for (const observation of observations) {
      if (this.insertObservation(contextName, observation)) {
        applied += 1;
      } else {
        duplicates += 1;
      }
    }

    return { applied, duplicates };
  }

  private insertObservation(
    contextName: string,
    observation: StatusObservation,
  ): boolean {
    const contextId = this.getOrCreateContextId(contextName);
    const deviceId = this.getOrCreateDeviceId(observation.deviceId);
    const secondaryKeyId =
      observation.secondaryKey === undefined
        ? 0
        : this.getOrCreateSecondaryKeyId(observation.secondaryKey);

    const insertResult = this.insertObservationStatement.run(
      contextId,
      observation.statusMetric,
      deviceId,
      secondaryKeyId,
      observation.observedAt,
    );
    if (numberFromSqlValue(insertResult.changes) === 0) {
      return false;
    }

    this.upsertAggregateStatement.run(
      contextId,
      observation.statusMetric,
      observation.observedAt,
      observation.observedAt,
    );
    return true;
  }

  private getOrCreateContextId(contextName: string): number {
    return getOrCreateId(
      this.contextIds,
      contextName,
      this.insertContextStatement,
      this.selectContextIdStatement,
    );
  }

  private getOrCreateDeviceId(deviceId: string): number {
    return getOrCreateId(
      this.deviceIds,
      deviceId,
      this.insertDeviceStatement,
      this.selectDeviceIdStatement,
    );
  }

  private getOrCreateSecondaryKeyId(secondaryKey: string): number {
    return getOrCreateId(
      this.secondaryKeyIds,
      secondaryKey,
      this.insertSecondaryKeyStatement,
      this.selectSecondaryKeyIdStatement,
    );
  }

  private withTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("SQLite status store is not ready");
    }
  }

  private closeSync(): void {
    if (this.db.isOpen) {
      this.db.close();
      this.ready = false;
      this.logger.info(
        { database_path: this.databasePath },
        "closed sqlite status store",
      );
    }
  }
}

interface ContextState {
  status: StatusSnapshot;
  identities: Map<StatusMetricKey, Set<string>>;
}

function createContextState(initialStatus?: StatusSnapshot): ContextState {
  return {
    status: cloneStatus(initialStatus ?? createEmptyStatus()),
    identities: new Map(statusMetricKeys.map((key) => [key, new Set()])),
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

  const identityKey = identityKeyForObservation(observation);
  if (metricIdentities.has(identityKey)) {
    return false;
  }

  metricIdentities.add(identityKey);
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

function isStatusMetricKey(value: unknown): value is StatusMetricKey {
  return typeof value === "string" && statusMetricKeys.includes(value as StatusMetricKey);
}

interface LegacyObservation {
  statusMetric: StatusMetricKey;
  identityKey: string;
  observedAt: string;
}

interface LegacyMigrationSummary {
  contexts: number;
  scanned: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  renamed: number;
}

interface ParsedLegacyObservation {
  ok: true;
  value: LegacyObservation;
}

interface FailedLegacyObservationParse {
  ok: false;
  reason: string;
  statusMetric?: unknown;
}

type LegacyObservationParseResult =
  | ParsedLegacyObservation
  | FailedLegacyObservationParse;

const legacyMigrationName = "legacy-status-ndjson-v1";
const archivedLegacyLedgerFileName = "observations.ndjson.migrated";

const noopLogger: StateStoreLogger = {
  info() {
    return undefined;
  },
  warn() {
    return undefined;
  },
  error() {
    return undefined;
  },
};

function getOrCreateId(
  cache: Map<string, number>,
  value: string,
  insertStatement: StatementSync,
  selectStatement: StatementSync,
): number {
  const cached = cache.get(value);
  if (cached !== undefined) {
    return cached;
  }

  insertStatement.run(value);
  const row = selectStatement.get(value);
  if (!row) {
    throw new Error("Failed to load SQLite dictionary row");
  }

  const id = numberFromSqlValue(row.id);
  cache.set(value, id);
  return id;
}

function identityKeyForObservation(observation: StatusObservation): string {
  return [
    observation.deviceId,
    observation.secondaryKey ?? "",
    observation.observedAt,
  ].join("\u001f");
}

function numberFromSqlValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  throw new Error("Expected SQLite numeric value");
}

function stringOrNullFromSqlValue(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error("Expected SQLite string value");
}

function legacyContextDirectories(
  basePath: string,
): Array<{ name: string; path: string }> {
  return readdirSync(basePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(basePath, entry.name),
    }));
}

function archivedLegacyLedgerPath(ledgerPath: string): string {
  const directory = dirname(ledgerPath);
  let candidate = join(directory, archivedLegacyLedgerFileName);
  let suffix = 1;

  while (existsSync(candidate)) {
    candidate = join(directory, `${archivedLegacyLedgerFileName}.${suffix}`);
    suffix += 1;
  }

  return candidate;
}

function decodeContextName(encodedContextName: string): string {
  try {
    return decodeURIComponent(encodedContextName);
  } catch {
    return encodedContextName;
  }
}

function parseLegacyObservationLine(line: string): LegacyObservationParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const candidate = parsed as Partial<LegacyObservation>;
  if (!isStatusMetricKey(candidate.statusMetric)) {
    return {
      ok: false,
      reason: "invalid_status_metric",
      statusMetric: candidate.statusMetric,
    };
  }

  if (
    typeof candidate.identityKey !== "string" ||
    candidate.identityKey.length === 0
  ) {
    return {
      ok: false,
      reason: "invalid_identity_key",
      statusMetric: candidate.statusMetric,
    };
  }

  if (
    typeof candidate.observedAt !== "string" ||
    candidate.observedAt.length === 0
  ) {
    return {
      ok: false,
      reason: "invalid_observed_at",
      statusMetric: candidate.statusMetric,
    };
  }

  return {
    ok: true,
    value: {
      statusMetric: candidate.statusMetric,
      identityKey: candidate.identityKey,
      observedAt: candidate.observedAt,
    },
  };
}

function legacyObservationToStructuredObservation(
  observation: LegacyObservation,
): { ok: true; value: StatusObservation } | FailedLegacyObservationParse {
  const suffix = `:${observation.observedAt}`;
  if (!observation.identityKey.endsWith(suffix)) {
    return {
      ok: false,
      reason: "identity_missing_observed_at_suffix",
      statusMetric: observation.statusMetric,
    };
  }

  const prefix = observation.identityKey.slice(0, -suffix.length);
  if (prefix.length === 0) {
    return {
      ok: false,
      reason: "empty_device_id",
      statusMetric: observation.statusMetric,
    };
  }

  if (observation.statusMetric !== "quantity_samples") {
    return {
      ok: true,
      value: {
        statusMetric: observation.statusMetric,
        deviceId: prefix,
        observedAt: observation.observedAt,
      },
    };
  }

  const secondarySeparatorIndex = prefix.lastIndexOf(":");
  if (
    secondarySeparatorIndex <= 0 ||
    secondarySeparatorIndex === prefix.length - 1
  ) {
    return {
      ok: false,
      reason: "invalid_quantity_identity",
      statusMetric: observation.statusMetric,
    };
  }

  return {
    ok: true,
    value: {
      statusMetric: observation.statusMetric,
      deviceId: prefix.slice(0, secondarySeparatorIndex),
      secondaryKey: prefix.slice(secondarySeparatorIndex + 1),
      observedAt: observation.observedAt,
    },
  };
}
