import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { BatchRequest, NormalizedRecord } from "../ingest.js";
import {
  canonicalMetricCatalog,
  canonicalObservationsForRecord,
  getCanonicalMetric,
  type CanonicalMetric,
} from "../v2/catalog.js";
import type { AppConfig } from "../config.js";

export const healthSaveSourcePluginId = "apple-healthkit-ios";

export interface StoredObservation {
  context: string;
  metric_id: string;
  display_name: string;
  category: string;
  value_type: string;
  canonical_unit: string | null;
  t: string;
  value: number | null;
  code: string | null;
  unit: string | null;
  source_id: string;
  stream_id: string;
  original_metric: string;
  normalized_metric: string;
  sample_json: string;
  ingested_at: string;
}

export interface SourceView {
  id: string;
  plugin_id: string;
  display_name: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface StreamView {
  id: string;
  source_plugin_id: string;
  origin_key: string;
  device_label: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DeviceView {
  device_label: string;
  stream_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface PaginationInput {
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  count: number;
  total: number;
  items: T[];
}

export interface ObservationQuery {
  metricId?: string;
  streamId?: string;
  start?: string;
  end?: string;
  limit?: number;
}

export interface ExportMetricSummary {
  metric: string;
  display_name: string;
  count: number;
  oldest: string | null;
  newest: string | null;
}

export interface ReadinessMetric {
  metric_id: string;
  display_name: string;
  category: string;
  observation_count: number;
  days_with_data: number;
  first_observation_at: string | null;
  last_observation_at: string | null;
  analyzable: {
    anomaly_detection: SufficiencyView;
    trend_analysis: SufficiencyView;
  };
}

export interface SufficiencyView {
  is_sufficient: boolean;
  missing: string | null;
  days_until_sufficient: number;
}

export interface ReadinessSource {
  source_plugin_id: string;
  observation_count: number;
  last_ingested_at: string | null;
}

export interface IntelligenceConnectionView {
  id: number;
  provider: string;
  model: string;
  destination: "local" | "cloud";
  key_last4: string | null;
  enabled: boolean;
}

export interface IntelligenceFallbackView {
  priority: number;
  connection_id: number;
  provider: string;
  model: string;
  destination: "local" | "cloud";
}

export interface IntelligenceSettingsView {
  mode: "off" | "local" | "cloud";
  managed_by_env: boolean;
  env_provider: string | null;
  allow_cloud_egress: boolean;
  redact_cloud_prompts: boolean;
  revision: number;
  consent: {
    granted: boolean;
    version: string | null;
    at: string | null;
  };
  primary: IntelligenceConnectionView | null;
  fallback: IntelligenceFallbackView[];
}

export interface UpdateIntelligenceInput {
  mode?: "off" | "local" | "cloud";
  primary?: {
    provider?: string;
    model?: string;
    base_url?: string;
    api_key?: string;
  } | null;
  redact_cloud_prompts?: boolean;
  fallback?: IntelligenceFallbackView[];
}

export interface ConsentInput {
  granted: boolean;
  consent_version?: string;
  consent_text_hash?: string | null;
}

export interface AuditEventView {
  id: number;
  actor: string;
  event_type: string;
  before_revision: number | null;
  after_revision: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ExperimentView {
  id: string;
  status: "running" | "abandoned" | "analyzed";
  hypothesis: string | null;
  design: string;
  lever: string | null;
  lever_metric_id: string;
  outcome: string | null;
  outcome_metric_id: string;
  block_days: number;
  start_date: string;
  created_at: string;
  calendar: Array<{
    index: number;
    label: "A" | "B";
    start: string;
    end: string;
  }>;
  progress: {
    day_index: number;
    total_days: number;
    days_remaining: number;
    pct: number;
    current_phase: "A" | "B";
    is_complete: boolean;
  };
  results: Record<string, unknown>;
}

export interface CreateExperimentInput {
  lever_metric_id: string;
  outcome_metric_id: string;
  hypothesis?: string;
  design?: string;
  block_days?: number;
  start_date?: string;
}

export interface ReadStore {
  recordBatch(input: {
    contextName: string;
    batch: BatchRequest;
    records: NormalizedRecord[];
    ingestedAt?: string;
  }): Promise<void>;
  listObservations(
    contextName: string,
    query?: ObservationQuery,
  ): Promise<StoredObservation[]>;
  listExportMetrics(contextName: string): Promise<ExportMetricSummary[]>;
  listSources(contextName: string, pagination?: PaginationInput): Promise<Page<SourceView>>;
  listStreams(contextName: string, pagination?: PaginationInput): Promise<Page<StreamView>>;
  getStream(contextName: string, streamId: string): Promise<StreamView | undefined>;
  listDevices(contextName: string, pagination?: PaginationInput): Promise<Page<DeviceView>>;
  getReadiness(contextName: string): Promise<{
    as_of: string;
    last_observation_at: string | null;
    last_ingested_at: string | null;
    sources: ReadinessSource[];
    metrics: ReadinessMetric[];
    summary: { metrics_with_data: number };
  }>;
  getLastIngestedAt(contextName: string): Promise<string | null>;
  getIntelligenceSettings(contextName: string): Promise<IntelligenceSettingsView>;
  updateIntelligenceSettings(
    contextName: string,
    input: UpdateIntelligenceInput,
  ): Promise<IntelligenceSettingsView>;
  updateConsent(
    contextName: string,
    input: ConsentInput,
  ): Promise<IntelligenceSettingsView>;
  recordAuditEvent(
    contextName: string,
    event: Omit<AuditEventView, "id" | "created_at"> & { created_at?: string },
  ): Promise<AuditEventView>;
  listAuditEvents(contextName: string, limit: number): Promise<AuditEventView[]>;
  listExperiments(contextName: string): Promise<ExperimentView[]>;
  createExperiment(
    contextName: string,
    input: CreateExperimentInput,
  ): Promise<ExperimentView>;
  getExperiment(
    contextName: string,
    experimentId: string,
  ): Promise<ExperimentView | undefined>;
  updateExperimentStatus(
    contextName: string,
    experimentId: string,
    status: ExperimentView["status"],
  ): Promise<ExperimentView | undefined>;
  isReady(): boolean;
  close(): Promise<void>;
}

export function createReadStore(config: AppConfig): ReadStore {
  if (config.stateBackend === "memory") {
    return createMemoryReadStore();
  }

  return new SQLiteReadStore(join(config.dataPath, "read"));
}

export function createMemoryReadStore(): ReadStore {
  const observationsByContext = new Map<string, Map<string, StoredObservation>>();
  const sourcesByContext = new Map<string, Map<string, SourceView>>();
  const streamsByContext = new Map<string, Map<string, StreamView>>();
  const settingsByContext = new Map<string, IntelligenceSettingsView>();
  const auditEventsByContext = new Map<string, AuditEventView[]>();
  const experimentsByContext = new Map<string, Map<string, ExperimentView>>();
  let auditId = 0;

  return {
    async recordBatch(input) {
      const contextName = normalizeContextName(input.contextName);
      const ingestedAt = input.ingestedAt ?? new Date().toISOString();
      const source = sourceFromPlugin(healthSaveSourcePluginId, ingestedAt);
      const sources = contextMap(sourcesByContext, contextName);
      const existingSource = sources.get(source.id);
      sources.set(source.id, mergeSource(existingSource, source));

      for (const record of input.records) {
        const stream = streamFromRecord(record, ingestedAt);
        const streams = contextMap(streamsByContext, contextName);
        streams.set(stream.id, mergeStream(streams.get(stream.id), stream));

        for (const observation of observationsFromRecord(
          contextName,
          record,
          stream.id,
          ingestedAt,
        )) {
          contextMap(observationsByContext, contextName).set(
            observationDedupeKey(observation),
            observation,
          );
        }
      }
    },

    async listObservations(contextName, query = {}) {
      return filterObservations(
        [...contextMap(observationsByContext, contextName).values()],
        query,
      );
    },

    async listExportMetrics(contextName) {
      return exportMetricSummaries([
        ...contextMap(observationsByContext, contextName).values(),
      ]);
    },

    async listSources(contextName, pagination) {
      return pageItems(
        [...contextMap(sourcesByContext, contextName).values()].sort((left, right) =>
          left.plugin_id.localeCompare(right.plugin_id),
        ),
        pagination,
      );
    },

    async listStreams(contextName, pagination) {
      return pageItems(
        [...contextMap(streamsByContext, contextName).values()].sort((left, right) =>
          right.last_seen_at.localeCompare(left.last_seen_at),
        ),
        pagination,
      );
    },

    async getStream(contextName, streamId) {
      return contextMap(streamsByContext, contextName).get(streamId);
    },

    async listDevices(contextName, pagination) {
      return pageItems(devicesFromStreams([...contextMap(streamsByContext, contextName).values()]), pagination);
    },

    async getReadiness(contextName) {
      return readinessFromObservations(
        [...contextMap(observationsByContext, contextName).values()],
        [...contextMap(sourcesByContext, contextName).values()],
      );
    },

    async getLastIngestedAt(contextName) {
      return maxString(
        [...contextMap(observationsByContext, contextName).values()].map(
          (observation) => observation.ingested_at,
        ),
      );
    },

    async getIntelligenceSettings(contextName) {
      return settingsByContext.get(normalizeContextName(contextName)) ?? defaultIntelligenceSettings();
    },

    async updateIntelligenceSettings(contextName, input) {
      const before = settingsByContext.get(normalizeContextName(contextName)) ?? defaultIntelligenceSettings();
      const after = applyIntelligenceUpdate(before, input);
      settingsByContext.set(normalizeContextName(contextName), after);
      return after;
    },

    async updateConsent(contextName, input) {
      const before = settingsByContext.get(normalizeContextName(contextName)) ?? defaultIntelligenceSettings();
      const after = applyConsentUpdate(before, input);
      settingsByContext.set(normalizeContextName(contextName), after);
      return after;
    },

    async recordAuditEvent(contextName, event) {
      const createdAt = event.created_at ?? new Date().toISOString();
      const nextEvent = {
        ...event,
        id: ++auditId,
        created_at: createdAt,
      };
      contextArray(auditEventsByContext, contextName).push(nextEvent);
      return nextEvent;
    },

    async listAuditEvents(contextName, limit) {
      return [...contextArray(auditEventsByContext, contextName)]
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit);
    },

    async listExperiments(contextName) {
      return [...contextMap(experimentsByContext, contextName).values()].sort(
        (left, right) => right.created_at.localeCompare(left.created_at),
      );
    },

    async createExperiment(contextName, input) {
      const experiment = createExperimentView(input);
      contextMap(experimentsByContext, contextName).set(experiment.id, experiment);
      return experiment;
    },

    async getExperiment(contextName, experimentId) {
      return contextMap(experimentsByContext, contextName).get(experimentId);
    },

    async updateExperimentStatus(contextName, experimentId, status) {
      const experiments = contextMap(experimentsByContext, contextName);
      const experiment = experiments.get(experimentId);
      if (!experiment) {
        return undefined;
      }

      const updated = { ...experiment, status };
      experiments.set(experimentId, updated);
      return updated;
    },

    isReady() {
      return true;
    },

    async close() {
      return undefined;
    },
  };
}

export class SQLiteReadStore implements ReadStore {
  private readonly db: DatabaseSync;
  private ready = false;

  constructor(private readonly basePath: string) {
    mkdirSync(basePath, { recursive: true });
    this.db = new DatabaseSync(join(basePath, "read.sqlite"), {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
    });
    this.initializeDatabase();
    this.ready = true;
  }

  async recordBatch(input: {
    contextName: string;
    batch: BatchRequest;
    records: NormalizedRecord[];
    ingestedAt?: string;
  }): Promise<void> {
    this.assertReady();
    const contextName = normalizeContextName(input.contextName);
    const ingestedAt = input.ingestedAt ?? new Date().toISOString();
    const source = sourceFromPlugin(healthSaveSourcePluginId, ingestedAt);

    this.db.exec("BEGIN");
    try {
      this.upsertSource(contextName, source);
      for (const record of input.records) {
        const stream = streamFromRecord(record, ingestedAt);
        this.upsertStream(contextName, stream);
        for (const observation of observationsFromRecord(
          contextName,
          record,
          stream.id,
          ingestedAt,
        )) {
          this.insertObservation(observation);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async listObservations(
    contextName: string,
    query: ObservationQuery = {},
  ): Promise<StoredObservation[]> {
    this.assertReady();
    const rows = this.db
      .prepare("SELECT * FROM observations WHERE context = ? ORDER BY t DESC, metric_id ASC")
      .all(normalizeContextName(contextName))
      .map(observationFromRow);
    return filterObservations(rows, query);
  }

  async listExportMetrics(contextName: string): Promise<ExportMetricSummary[]> {
    this.assertReady();
    return exportMetricSummaries(await this.listObservations(contextName));
  }

  async listSources(
    contextName: string,
    pagination?: PaginationInput,
  ): Promise<Page<SourceView>> {
    this.assertReady();
    const rows = this.db
      .prepare(
        "SELECT id, plugin_id, display_name, first_seen_at, last_seen_at FROM sources WHERE context = ? ORDER BY plugin_id ASC",
      )
      .all(normalizeContextName(contextName))
      .map(sourceFromRow);
    return pageItems(rows, pagination);
  }

  async listStreams(
    contextName: string,
    pagination?: PaginationInput,
  ): Promise<Page<StreamView>> {
    this.assertReady();
    const rows = this.db
      .prepare(
        "SELECT id, source_plugin_id, origin_key, device_label, first_seen_at, last_seen_at FROM streams WHERE context = ? ORDER BY last_seen_at DESC",
      )
      .all(normalizeContextName(contextName))
      .map(streamFromRow);
    return pageItems(rows, pagination);
  }

  async getStream(
    contextName: string,
    streamId: string,
  ): Promise<StreamView | undefined> {
    this.assertReady();
    const row = this.db
      .prepare(
        "SELECT id, source_plugin_id, origin_key, device_label, first_seen_at, last_seen_at FROM streams WHERE context = ? AND id = ?",
      )
      .get(normalizeContextName(contextName), streamId);
    return row ? streamFromRow(row) : undefined;
  }

  async listDevices(
    contextName: string,
    pagination?: PaginationInput,
  ): Promise<Page<DeviceView>> {
    this.assertReady();
    const streams = (await this.listStreams(contextName)).items;
    return pageItems(devicesFromStreams(streams), pagination);
  }

  async getReadiness(contextName: string): Promise<{
    as_of: string;
    last_observation_at: string | null;
    last_ingested_at: string | null;
    sources: ReadinessSource[];
    metrics: ReadinessMetric[];
    summary: { metrics_with_data: number };
  }> {
    this.assertReady();
    const [observations, sources] = await Promise.all([
      this.listObservations(contextName),
      this.listSources(contextName),
    ]);
    return readinessFromObservations(observations, sources.items);
  }

  async getLastIngestedAt(contextName: string): Promise<string | null> {
    this.assertReady();
    const row = this.db
      .prepare("SELECT MAX(ingested_at) AS latest FROM observations WHERE context = ?")
      .get(normalizeContextName(contextName)) as { latest?: unknown } | undefined;
    return stringOrNull(row?.latest);
  }

  async getIntelligenceSettings(contextName: string): Promise<IntelligenceSettingsView> {
    this.assertReady();
    return this.getStoredSettings(normalizeContextName(contextName));
  }

  async updateIntelligenceSettings(
    contextName: string,
    input: UpdateIntelligenceInput,
  ): Promise<IntelligenceSettingsView> {
    this.assertReady();
    const context = normalizeContextName(contextName);
    const before = this.getStoredSettings(context);
    const after = applyIntelligenceUpdate(before, input);
    this.storeSettings(context, after);
    return after;
  }

  async updateConsent(
    contextName: string,
    input: ConsentInput,
  ): Promise<IntelligenceSettingsView> {
    this.assertReady();
    const context = normalizeContextName(contextName);
    const before = this.getStoredSettings(context);
    const after = applyConsentUpdate(before, input);
    this.storeSettings(context, after);
    return after;
  }

  async recordAuditEvent(
    contextName: string,
    event: Omit<AuditEventView, "id" | "created_at"> & { created_at?: string },
  ): Promise<AuditEventView> {
    this.assertReady();
    const createdAt = event.created_at ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO audit_events (
          context, actor, event_type, before_revision, after_revision, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalizeContextName(contextName),
        event.actor,
        event.event_type,
        event.before_revision,
        event.after_revision,
        JSON.stringify(event.metadata),
        createdAt,
      );

    return {
      ...event,
      id: Number(result.lastInsertRowid),
      created_at: createdAt,
    };
  }

  async listAuditEvents(contextName: string, limit: number): Promise<AuditEventView[]> {
    this.assertReady();
    return this.db
      .prepare(
        `SELECT id, actor, event_type, before_revision, after_revision, metadata_json, created_at
         FROM audit_events WHERE context = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(normalizeContextName(contextName), limit)
      .map(auditEventFromRow);
  }

  async listExperiments(contextName: string): Promise<ExperimentView[]> {
    this.assertReady();
    return this.db
      .prepare(
        "SELECT payload_json FROM experiments WHERE context = ? ORDER BY created_at DESC",
      )
      .all(normalizeContextName(contextName))
      .map((row) => JSON.parse(String((row as { payload_json: string }).payload_json)) as ExperimentView);
  }

  async createExperiment(
    contextName: string,
    input: CreateExperimentInput,
  ): Promise<ExperimentView> {
    this.assertReady();
    const experiment = createExperimentView(input);
    this.storeExperiment(normalizeContextName(contextName), experiment);
    return experiment;
  }

  async getExperiment(
    contextName: string,
    experimentId: string,
  ): Promise<ExperimentView | undefined> {
    this.assertReady();
    const row = this.db
      .prepare(
        "SELECT payload_json FROM experiments WHERE context = ? AND id = ?",
      )
      .get(normalizeContextName(contextName), experimentId) as
      | { payload_json?: unknown }
      | undefined;
    return typeof row?.payload_json === "string"
      ? JSON.parse(row.payload_json) as ExperimentView
      : undefined;
  }

  async updateExperimentStatus(
    contextName: string,
    experimentId: string,
    status: ExperimentView["status"],
  ): Promise<ExperimentView | undefined> {
    const experiment = await this.getExperiment(contextName, experimentId);
    if (!experiment) {
      return undefined;
    }

    const updated = { ...experiment, status };
    this.storeExperiment(normalizeContextName(contextName), updated);
    return updated;
  }

  isReady(): boolean {
    return this.ready;
  }

  async close(): Promise<void> {
    this.ready = false;
    this.db.close();
  }

  private initializeDatabase(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sources (
        context TEXT NOT NULL,
        id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (context, id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS streams (
        context TEXT NOT NULL,
        id TEXT NOT NULL,
        source_plugin_id TEXT NOT NULL,
        origin_key TEXT NOT NULL,
        device_label TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (context, id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS observations (
        context TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        metric_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        category TEXT NOT NULL,
        value_type TEXT NOT NULL,
        canonical_unit TEXT,
        t TEXT NOT NULL,
        value REAL,
        code TEXT,
        unit TEXT,
        source_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        original_metric TEXT NOT NULL,
        normalized_metric TEXT NOT NULL,
        sample_json TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        PRIMARY KEY (context, dedupe_key)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_observations_context_metric_time
        ON observations (context, metric_id, t);
      CREATE INDEX IF NOT EXISTS idx_observations_context_stream
        ON observations (context, stream_id);

      CREATE TABLE IF NOT EXISTS intelligence_settings (
        context TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY,
        context TEXT NOT NULL,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        before_revision INTEGER,
        after_revision INTEGER,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS experiments (
        context TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (context, id)
      ) STRICT;
    `);
  }

  private upsertSource(contextName: string, source: SourceView): void {
    this.db
      .prepare(
        `INSERT INTO sources (
          context, id, plugin_id, display_name, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(context, id) DO UPDATE SET
          display_name = excluded.display_name,
          first_seen_at = CASE
            WHEN excluded.first_seen_at < sources.first_seen_at THEN excluded.first_seen_at
            ELSE sources.first_seen_at
          END,
          last_seen_at = CASE
            WHEN excluded.last_seen_at > sources.last_seen_at THEN excluded.last_seen_at
            ELSE sources.last_seen_at
          END`,
      )
      .run(
        contextName,
        source.id,
        source.plugin_id,
        source.display_name,
        source.first_seen_at,
        source.last_seen_at,
      );
  }

  private upsertStream(contextName: string, stream: StreamView): void {
    this.db
      .prepare(
        `INSERT INTO streams (
          context, id, source_plugin_id, origin_key, device_label, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(context, id) DO UPDATE SET
          device_label = excluded.device_label,
          first_seen_at = CASE
            WHEN excluded.first_seen_at < streams.first_seen_at THEN excluded.first_seen_at
            ELSE streams.first_seen_at
          END,
          last_seen_at = CASE
            WHEN excluded.last_seen_at > streams.last_seen_at THEN excluded.last_seen_at
            ELSE streams.last_seen_at
          END`,
      )
      .run(
        contextName,
        stream.id,
        stream.source_plugin_id,
        stream.origin_key,
        stream.device_label,
        stream.first_seen_at,
        stream.last_seen_at,
      );
  }

  private insertObservation(observation: StoredObservation): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO observations (
          context, dedupe_key, metric_id, display_name, category, value_type,
          canonical_unit, t, value, code, unit, source_id, stream_id,
          original_metric, normalized_metric, sample_json, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observation.context,
        observationDedupeKey(observation),
        observation.metric_id,
        observation.display_name,
        observation.category,
        observation.value_type,
        observation.canonical_unit,
        observation.t,
        observation.value,
        observation.code,
        observation.unit,
        observation.source_id,
        observation.stream_id,
        observation.original_metric,
        observation.normalized_metric,
        observation.sample_json,
        observation.ingested_at,
      );
  }

  private getStoredSettings(contextName: string): IntelligenceSettingsView {
    const row = this.db
      .prepare("SELECT payload_json FROM intelligence_settings WHERE context = ?")
      .get(contextName) as { payload_json?: unknown } | undefined;
    return typeof row?.payload_json === "string"
      ? JSON.parse(row.payload_json) as IntelligenceSettingsView
      : defaultIntelligenceSettings();
  }

  private storeSettings(
    contextName: string,
    settings: IntelligenceSettingsView,
  ): void {
    this.db
      .prepare(
        `INSERT INTO intelligence_settings (context, payload_json)
         VALUES (?, ?)
         ON CONFLICT(context) DO UPDATE SET payload_json = excluded.payload_json`,
      )
      .run(contextName, JSON.stringify(settings));
  }

  private storeExperiment(contextName: string, experiment: ExperimentView): void {
    this.db
      .prepare(
        `INSERT INTO experiments (context, id, created_at, payload_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(context, id) DO UPDATE SET payload_json = excluded.payload_json`,
      )
      .run(contextName, experiment.id, experiment.created_at, JSON.stringify(experiment));
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("SQLite read store is not ready");
    }
  }
}

export function deterministicUuid(input: string): string {
  const hash = createHash("sha1").update(input).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function observationsFromRecord(
  contextName: string,
  record: NormalizedRecord,
  streamId: string,
  ingestedAt: string,
): StoredObservation[] {
  return canonicalObservationsForRecord(record).map((observation) => ({
    context: contextName,
    metric_id: observation.metric.id,
    display_name: observation.metric.display_name,
    category: observation.metric.category,
    value_type: observation.metric.value_type,
    canonical_unit: observation.metric.canonical_unit,
    t: observation.t,
    value: observation.value,
    code: observation.code,
    unit: observation.unit,
    source_id: sourceIdFromDevice(record.deviceId),
    stream_id: streamId,
    original_metric: record.metric,
    normalized_metric: record.normalizedMetric,
    sample_json: JSON.stringify(record.normalizedSample),
    ingested_at: ingestedAt,
  }));
}

function sourceFromPlugin(pluginId: string, seenAt: string): SourceView {
  return {
    id: deterministicUuid(`source:${pluginId}`),
    plugin_id: pluginId,
    display_name: pluginId,
    first_seen_at: seenAt,
    last_seen_at: seenAt,
  };
}

function streamFromRecord(record: NormalizedRecord, seenAt: string): StreamView {
  const originKey = normalizeOriginKey(record.deviceId);
  return {
    id: deterministicUuid(`stream:${healthSaveSourcePluginId}:${originKey}`),
    source_plugin_id: healthSaveSourcePluginId,
    origin_key: originKey,
    device_label: record.deviceId,
    first_seen_at: seenAt,
    last_seen_at: seenAt,
  };
}

function mergeSource(
  existing: SourceView | undefined,
  next: SourceView,
): SourceView {
  return existing
    ? {
        ...existing,
        display_name: next.display_name,
        first_seen_at: minString([existing.first_seen_at, next.first_seen_at])!,
        last_seen_at: maxString([existing.last_seen_at, next.last_seen_at])!,
      }
    : next;
}

function mergeStream(
  existing: StreamView | undefined,
  next: StreamView,
): StreamView {
  return existing
    ? {
        ...existing,
        device_label: next.device_label,
        first_seen_at: minString([existing.first_seen_at, next.first_seen_at])!,
        last_seen_at: maxString([existing.last_seen_at, next.last_seen_at])!,
      }
    : next;
}

function filterObservations(
  observations: StoredObservation[],
  query: ObservationQuery,
): StoredObservation[] {
  const filtered = observations
    .filter((observation) =>
      query.metricId ? observation.metric_id === query.metricId : true,
    )
    .filter((observation) =>
      query.streamId ? observation.stream_id === query.streamId : true,
    )
    .filter((observation) => query.start ? observation.t >= query.start : true)
    .filter((observation) => query.end ? observation.t <= query.end : true)
    .sort((left, right) => left.t.localeCompare(right.t));

  return query.limit && query.limit > 0 ? filtered.slice(0, query.limit) : filtered;
}

function exportMetricSummaries(
  observations: StoredObservation[],
): ExportMetricSummary[] {
  const byMetric = new Map<string, StoredObservation[]>();
  for (const observation of observations) {
    const entries = byMetric.get(observation.metric_id) ?? [];
    entries.push(observation);
    byMetric.set(observation.metric_id, entries);
  }

  return [...byMetric.entries()]
    .map(([metric, metricObservations]) => ({
      metric,
      display_name: metricObservations[0]?.display_name ?? metric,
      count: metricObservations.length,
      oldest: minString(metricObservations.map((observation) => observation.t)),
      newest: maxString(metricObservations.map((observation) => observation.t)),
    }))
    .sort((left, right) => left.metric.localeCompare(right.metric));
}

function readinessFromObservations(
  observations: StoredObservation[],
  sources: SourceView[],
) {
  const sourceCounts = sources.map((source) => ({
    source_plugin_id: source.plugin_id,
    observation_count: observations.filter(
      (observation) =>
        observation.stream_id &&
        observation.source_id.length > 0,
    ).length,
    last_ingested_at: source.last_seen_at,
  }));
  const metrics = exportMetricSummaries(observations).map((metric) => {
    const catalogMetric = getCanonicalMetric(metric.metric) ?? metricFromSummary(metric);
    const metricObservations = observations.filter(
      (observation) => observation.metric_id === metric.metric,
    );
    const daysWithData = new Set(
      metricObservations.map((observation) => observation.t.slice(0, 10)),
    ).size;
    const trendSufficiency = sufficiency(daysWithData, 14, "14 days with data");
    const anomalySufficiency = sufficiency(daysWithData, 7, "7 days with data");

    return {
      metric_id: catalogMetric.id,
      display_name: catalogMetric.display_name,
      category: catalogMetric.category,
      observation_count: metric.count,
      days_with_data: daysWithData,
      first_observation_at: metric.oldest,
      last_observation_at: metric.newest,
      analyzable: {
        anomaly_detection: anomalySufficiency,
        trend_analysis: trendSufficiency,
      },
    };
  });

  return {
    as_of: new Date().toISOString(),
    last_observation_at: maxString(observations.map((observation) => observation.t)),
    last_ingested_at: maxString(observations.map((observation) => observation.ingested_at)),
    sources: sourceCounts,
    metrics,
    summary: {
      metrics_with_data: metrics.length,
    },
  };
}

function devicesFromStreams(streams: StreamView[]): DeviceView[] {
  const byDevice = new Map<string, StreamView[]>();
  for (const stream of streams) {
    const deviceStreams = byDevice.get(stream.device_label) ?? [];
    deviceStreams.push(stream);
    byDevice.set(stream.device_label, deviceStreams);
  }

  return [...byDevice.entries()]
    .map(([deviceLabel, deviceStreams]) => ({
      device_label: deviceLabel,
      stream_count: deviceStreams.length,
      first_seen_at: minString(deviceStreams.map((stream) => stream.first_seen_at))!,
      last_seen_at: maxString(deviceStreams.map((stream) => stream.last_seen_at))!,
    }))
    .sort((left, right) => left.device_label.localeCompare(right.device_label));
}

function pageItems<T>(items: T[], pagination: PaginationInput = {}): Page<T> {
  const offset = Math.max(0, pagination.offset ?? 0);
  const limit = pagination.limit;
  const paged =
    limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit);
  return {
    count: paged.length,
    total: items.length,
    items: paged,
  };
}

function sufficiency(
  daysWithData: number,
  requiredDays: number,
  missingLabel: string,
): SufficiencyView {
  const daysUntilSufficient = Math.max(0, requiredDays - daysWithData);
  return {
    is_sufficient: daysUntilSufficient === 0,
    missing: daysUntilSufficient === 0 ? null : missingLabel,
    days_until_sufficient: daysUntilSufficient,
  };
}

function defaultIntelligenceSettings(): IntelligenceSettingsView {
  return {
    mode: "off",
    managed_by_env: false,
    env_provider: null,
    allow_cloud_egress: false,
    redact_cloud_prompts: true,
    revision: 0,
    consent: {
      granted: false,
      version: null,
      at: null,
    },
    primary: null,
    fallback: [],
  };
}

function applyIntelligenceUpdate(
  before: IntelligenceSettingsView,
  input: UpdateIntelligenceInput,
): IntelligenceSettingsView {
  const primary = input.primary
    ? {
        id: before.primary?.id ?? 1,
        provider: input.primary.provider ?? before.primary?.provider ?? "ollama",
        model: input.primary.model ?? before.primary?.model ?? "unknown",
        destination: destinationForProvider(input.primary.provider ?? before.primary?.provider),
        key_last4: keyLast4(input.primary.api_key) ?? before.primary?.key_last4 ?? null,
        enabled: true,
      }
    : input.primary === null
      ? null
      : before.primary;

  return {
    ...before,
    mode: input.mode ?? before.mode,
    redact_cloud_prompts:
      input.redact_cloud_prompts ?? before.redact_cloud_prompts,
    revision: before.revision + 1,
    primary,
    fallback: input.fallback ?? before.fallback,
  };
}

function applyConsentUpdate(
  before: IntelligenceSettingsView,
  input: ConsentInput,
): IntelligenceSettingsView {
  return {
    ...before,
    allow_cloud_egress: input.granted,
    revision: before.revision + 1,
    consent: {
      granted: input.granted,
      version: input.consent_version ?? "2026-06",
      at: new Date().toISOString(),
    },
  };
}

function createExperimentView(input: CreateExperimentInput): ExperimentView {
  const blockDays = clampInteger(input.block_days ?? 7, 1, 365);
  const startDate = input.start_date ?? new Date().toISOString().slice(0, 10);
  const totalDays = blockDays * 2;
  return {
    id: `exp_${randomUUID()}`,
    status: "running",
    hypothesis: input.hypothesis ?? null,
    design: input.design ?? "AB",
    lever: input.lever_metric_id,
    lever_metric_id: input.lever_metric_id,
    outcome: input.outcome_metric_id,
    outcome_metric_id: input.outcome_metric_id,
    block_days: blockDays,
    start_date: startDate,
    created_at: new Date().toISOString(),
    calendar: [
      {
        index: 0,
        label: "A",
        start: `${startDate}T00:00:00Z`,
        end: addDays(startDate, blockDays),
      },
      {
        index: 1,
        label: "B",
        start: addDays(startDate, blockDays),
        end: addDays(startDate, totalDays),
      },
    ],
    progress: {
      day_index: 0,
      total_days: totalDays,
      days_remaining: totalDays,
      pct: 0,
      current_phase: "A",
      is_complete: false,
    },
    results: {},
  };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().replace(".000Z", "Z");
}

function destinationForProvider(provider: string | undefined): "local" | "cloud" {
  return !provider || provider === "ollama" || provider === "local"
    ? "local"
    : "cloud";
}

function keyLast4(value: string | undefined): string | null {
  return value && value.length >= 4 ? value.slice(-4) : null;
}

function sourceIdFromDevice(deviceId: string): string {
  return normalizeOriginKey(deviceId).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "healthsave";
}

function normalizeOriginKey(value: string): string {
  return value.trim().toLowerCase() || "healthsave";
}

function observationDedupeKey(observation: StoredObservation): string {
  return [
    observation.metric_id,
    observation.stream_id,
    observation.t,
    observation.value ?? "",
    observation.code ?? "",
  ].join("|");
}

function normalizeContextName(contextName: string | undefined): string {
  return contextName?.trim() || "default";
}

function contextMap<T>(
  parent: Map<string, Map<string, T>>,
  contextName: string,
): Map<string, T> {
  const normalizedContextName = normalizeContextName(contextName);
  const existing = parent.get(normalizedContextName);
  if (existing) {
    return existing;
  }

  const next = new Map<string, T>();
  parent.set(normalizedContextName, next);
  return next;
}

function contextArray<T>(
  parent: Map<string, T[]>,
  contextName: string,
): T[] {
  const normalizedContextName = normalizeContextName(contextName);
  const existing = parent.get(normalizedContextName);
  if (existing) {
    return existing;
  }

  const next: T[] = [];
  parent.set(normalizedContextName, next);
  return next;
}

function observationFromRow(row: unknown): StoredObservation {
  const value = row as Record<string, unknown>;
  return {
    context: String(value.context),
    metric_id: String(value.metric_id),
    display_name: String(value.display_name),
    category: String(value.category),
    value_type: String(value.value_type),
    canonical_unit: stringOrNull(value.canonical_unit),
    t: String(value.t),
    value: numberOrNull(value.value),
    code: stringOrNull(value.code),
    unit: stringOrNull(value.unit),
    source_id: String(value.source_id),
    stream_id: String(value.stream_id),
    original_metric: String(value.original_metric),
    normalized_metric: String(value.normalized_metric),
    sample_json: String(value.sample_json),
    ingested_at: String(value.ingested_at),
  };
}

function sourceFromRow(row: unknown): SourceView {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    plugin_id: String(value.plugin_id),
    display_name: String(value.display_name),
    first_seen_at: String(value.first_seen_at),
    last_seen_at: String(value.last_seen_at),
  };
}

function streamFromRow(row: unknown): StreamView {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    source_plugin_id: String(value.source_plugin_id),
    origin_key: String(value.origin_key),
    device_label: String(value.device_label),
    first_seen_at: String(value.first_seen_at),
    last_seen_at: String(value.last_seen_at),
  };
}

function auditEventFromRow(row: unknown): AuditEventView {
  const value = row as Record<string, unknown>;
  return {
    id: Number(value.id),
    actor: String(value.actor),
    event_type: String(value.event_type),
    before_revision: numberOrNull(value.before_revision),
    after_revision: numberOrNull(value.after_revision),
    metadata: parseJsonObject(value.metadata_json),
    created_at: String(value.created_at),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function metricFromSummary(summary: ExportMetricSummary): CanonicalMetric {
  return {
    id: summary.metric,
    display_name: summary.display_name,
    category: "quantity",
    value_type: "quantity",
    canonical_unit: null,
  };
}

function minString(values: string[]): string | null {
  return values.length > 0
    ? values.reduce((min, value) => (value < min ? value : min))
    : null;
}

function maxString(values: string[]): string | null {
  return values.length > 0
    ? values.reduce((max, value) => (value > max ? value : max))
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function knownCanonicalMetrics(): CanonicalMetric[] {
  return canonicalMetricCatalog;
}
