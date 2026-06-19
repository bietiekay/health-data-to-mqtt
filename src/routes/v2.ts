import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireApiKey } from "../auth.js";
import type { AppConfig, AppContextConfig } from "../config.js";
import { canonicalMetricCatalog, getCanonicalMetric } from "../v2/catalog.js";
import type {
  CreateExperimentInput,
  UpdateIntelligenceInput,
  ReadStore,
  StoredObservation,
} from "../state/read-store.js";
import type { SyncReceiptStore } from "../state/sync-receipts.js";
import { verifyWhoopSignature } from "../webhooks/whoop.js";

interface V2RouteOptions {
  config: AppConfig;
  context: AppContextConfig;
  syncReceiptStore: SyncReceiptStore;
  readStore: ReadStore;
}

interface TimeRangeQuery {
  range?: string;
  start?: string;
  end?: string;
  stream_id?: string;
  limit?: string;
}

interface BatchSeriesQuery extends TimeRangeQuery {
  ids?: string;
}

interface PaginationQuery {
  limit?: string;
  offset?: string;
}

interface InsightsTriggerBody {
  type?: string;
}

interface DecideBody {
  decision?: string;
  rationale?: string;
}

export async function registerV2Routes(
  app: FastifyInstance,
  options: V2RouteOptions,
): Promise<void> {
  app.get("/api/v2/meta", async () => ({
    v2_status: "active",
    versions: {
      api_contract: "1",
      ontology: "1",
      normalizer: "1",
      fusion_policy: "1",
    },
    decision_record: "ADR-0001",
  }));

  app.get("/api/v2/setup/diagnostics", async () => ({
    service: "health-data-to-mqtt",
    kind: "HealthSave MQTT API",
    status: "ok",
    auth_required: Boolean(options.config.apiKey),
    health_endpoint: contextPath(options.context, "/api/health"),
    status_endpoint: contextPath(options.context, "/api/apple/status"),
    ingest_endpoint: contextPath(options.context, "/api/apple/batch"),
    latest_sync_endpoint: contextPath(
      options.context,
      "/api/v2/sync/runs/latest",
    ),
    coverage_endpoint: contextPath(options.context, "/api/v2/sync/coverage"),
    anomalies_endpoint: contextPath(options.context, "/api/v2/sync/anomalies"),
    grafana_required: false,
    wrong_port_hint:
      "If you see Grafana auth JSON, Homepage HTML, or an MQTT broker response, the app is pointed at the wrong port. Use the Health Data to MQTT API base URL.",
  }));

  app.get("/api/v2/metrics", async () => canonicalMetricCatalog);

  app.get<{
    Params: { metric_id: string };
    Querystring: TimeRangeQuery;
  }>("/api/v2/metrics/:metric_id/series", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const metric = getCanonicalMetric(request.params.metric_id);
    if (!metric) {
      return reply.code(404).send({
        detail: "Unknown metric",
        metric_id: request.params.metric_id,
      });
    }

    const range = resolveRange(request.query);
    const observations = await options.readStore.listObservations(
      options.context.name,
      {
        metricId: metric.id,
        streamId: request.query.stream_id,
        start: range.start,
        end: range.end,
        limit: parseLimit(request.query.limit, 1, 100_000),
      },
    );

    return {
      metric,
      range: range.range,
      start: range.start,
      end: range.end,
      points: observations.map(pointFromObservation),
    };
  });

  app.get<{
    Querystring: BatchSeriesQuery;
  }>("/api/v2/series", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const ids = dedupeIds(request.query.ids);
    if (ids.length === 0) {
      return reply.code(422).send({ detail: "ids query parameter is required" });
    }

    if (ids.length > 24) {
      return reply.code(422).send({ detail: "ids may contain at most 24 metrics" });
    }

    const range = resolveRange(request.query);
    const series = await Promise.all(
      ids.map(async (metricId) => {
        const metric = getCanonicalMetric(metricId);
        if (!metric) {
          return { metric_id: metricId, error: "unknown metric" };
        }

        const observations = await options.readStore.listObservations(
          options.context.name,
          {
            metricId: metric.id,
            streamId: request.query.stream_id,
            start: range.start,
            end: range.end,
            limit: parseLimit(request.query.limit, 1, 100_000),
          },
        );

        return {
          metric,
          points: observations.map(pointFromObservation),
        };
      }),
    );

    return {
      range: range.range,
      start: range.start,
      end: range.end,
      series,
    };
  });

  app.get<{
    Querystring: PaginationQuery;
  }>("/api/v2/sources", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const page = await options.readStore.listSources(
      options.context.name,
      parsePagination(request.query),
    );
    return { count: page.count, total: page.total, sources: page.items };
  });

  app.get<{
    Querystring: PaginationQuery;
  }>("/api/v2/devices", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const page = await options.readStore.listDevices(
      options.context.name,
      parsePagination(request.query),
    );
    return { count: page.count, total: page.total, devices: page.items };
  });

  app.get<{
    Querystring: PaginationQuery;
  }>("/api/v2/streams", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const page = await options.readStore.listStreams(
      options.context.name,
      parsePagination(request.query),
    );
    return { count: page.count, total: page.total, streams: page.items };
  });

  app.get<{
    Params: { stream_id: string };
  }>("/api/v2/streams/:stream_id", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const stream = await options.readStore.getStream(
      options.context.name,
      request.params.stream_id,
    );
    if (!stream) {
      return reply.code(404).send({
        status: "not_found",
        error: "Stream not found",
        stream_id: request.params.stream_id,
      });
    }

    return stream;
  });

  app.get("/api/v2/readiness", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return options.readStore.getReadiness(options.context.name);
  });

  app.get("/api/v2/privacy", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const settings = await options.readStore.getIntelligenceSettings(
      options.context.name,
    );
    const destination = settings.primary?.destination ?? "local";
    return {
      provider: settings.primary?.provider ?? "none",
      destination,
      is_local: destination === "local",
      allow_cloud_egress: settings.allow_cloud_egress,
      cloud_active: settings.mode === "cloud" && settings.allow_cloud_egress,
      cloud_prompt_redaction: settings.redact_cloud_prompts,
      raw_observations_leave_host: false,
      egress: [
        {
          payload_class: "RAW_OBSERVATIONS",
          allowed: false,
          leaves_host: false,
          reason: "raw rows never cross the host boundary",
        },
        {
          payload_class: "DERIVED_FINDINGS",
          allowed: settings.allow_cloud_egress,
          leaves_host: settings.mode === "cloud" && settings.allow_cloud_egress,
          reason: settings.allow_cloud_egress
            ? "cloud egress consent granted for derived findings"
            : "cloud egress consent has not been granted",
        },
      ],
    };
  });

  app.get("/api/v2/intelligence", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return options.readStore.getIntelligenceSettings(options.context.name);
  });

  app.put<{
    Body: Record<string, unknown> | undefined;
  }>("/api/v2/intelligence", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const before = await options.readStore.getIntelligenceSettings(
      options.context.name,
    );
    const updated = await options.readStore.updateIntelligenceSettings(
      options.context.name,
      parseIntelligenceUpdate(request.body),
    );
    await options.readStore.recordAuditEvent(options.context.name, {
      actor: "user",
      event_type: "intelligence_settings_updated",
      before_revision: before.revision,
      after_revision: updated.revision,
      metadata: { mode: updated.mode, provider: updated.primary?.provider ?? null },
    });
    return updated;
  });

  app.post<{
    Body: Record<string, unknown> | undefined;
  }>("/api/v2/intelligence/consent", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const body = request.body ?? {};
    const granted = body.granted === true;
    const before = await options.readStore.getIntelligenceSettings(
      options.context.name,
    );
    if (granted && before.primary?.destination !== "cloud") {
      return reply.code(409).send({
        detail: "Cloud provider must be configured before cloud egress consent is granted",
      });
    }

    const updated = await options.readStore.updateConsent(options.context.name, {
      granted,
      consent_version:
        typeof body.consent_version === "string" ? body.consent_version : undefined,
      consent_text_hash:
        typeof body.consent_text_hash === "string"
          ? body.consent_text_hash
          : null,
    });
    await options.readStore.recordAuditEvent(options.context.name, {
      actor: "user",
      event_type: granted ? "consent_granted" : "consent_revoked",
      before_revision: before.revision,
      after_revision: updated.revision,
      metadata: {
        version: updated.consent.version,
      },
    });
    return updated.consent;
  });

  app.post<{
    Body: Record<string, unknown> | undefined;
  }>("/api/v2/intelligence/test-connection", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const body = request.body ?? {};
    const provider = typeof body.provider === "string" ? body.provider : "stored";
    const model = typeof body.model === "string" ? body.model : "stored";
    const destination = ["ollama", "local", "stored"].includes(provider)
      ? "local"
      : "cloud";
    await options.readStore.recordAuditEvent(options.context.name, {
      actor: "user",
      event_type: "provider_healthcheck",
      before_revision: null,
      after_revision: null,
      metadata: { provider, model, destination },
    });

    return {
      ok: true,
      destination,
      model,
      latency_ms: 0,
      error: null,
    };
  });

  app.get("/api/v2/intelligence/detect-local", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return {
      candidates: [
        { url: "http://ollama:11434", reachable: false, models: [] },
        { url: "http://host.docker.internal:11434", reachable: false, models: [] },
      ],
    };
  });

  app.get("/api/v2/sync/runs/latest", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const latestRun = await options.syncReceiptStore.getLatestRun(
      options.context.name,
    );
    if (!latestRun) {
      return emptyLatestSyncRunResponse();
    }

    return latestRun;
  });

  app.get<{
    Params: { sync_run_id: string };
  }>("/api/v2/sync/runs/:sync_run_id", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const syncRun = await options.syncReceiptStore.getRun(
      options.context.name,
      request.params.sync_run_id,
    );
    if (!syncRun) {
      return reply.code(404).send({
        status: "not_found",
        error: "Sync run not found",
        sync_run_id: request.params.sync_run_id,
      });
    }

    return syncRun;
  });

  app.get("/api/v2/sync/coverage", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return options.syncReceiptStore.getCoverage(options.context.name);
  });

  app.get("/api/v2/sync/anomalies", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return {
      status: "ok",
      count: 0,
      anomalies: [],
    };
  });

  app.get("/api/v2/changes", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const [lastIngestedAt, latestSyncRun] = await Promise.all([
      options.readStore.getLastIngestedAt(options.context.name),
      options.syncReceiptStore.getLatestRun(options.context.name),
    ]);
    const body = {
      last_ingested_at: lastIngestedAt,
      latest_sync_run: latestSyncRun
        ? {
            sync_run_id: latestSyncRun.sync_run_id,
            last_seen_at: latestSyncRun.newest_receipt_at,
          }
        : null,
      last_narrative_at: null,
      version_token: "",
    };
    const versionToken = etagForObject(body);
    if (request.headers["if-none-match"] === versionToken) {
      return reply.code(304).send();
    }

    return reply.header("etag", versionToken).send({
      ...body,
      version_token: versionToken,
    });
  });

  app.get<{
    Querystring: { limit?: string };
  }>("/api/v2/receipts", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const limit = parseLimit(request.query.limit, 1, 500) ?? 50;
    const [events, latestSyncRun, sources] = await Promise.all([
      options.readStore.listAuditEvents(options.context.name, limit),
      options.syncReceiptStore.getLatestRun(options.context.name),
      options.readStore.listSources(options.context.name),
    ]);

    return {
      events_unavailable: false,
      count: events.length,
      events,
      ingest: {
        sources: sources.items.map((source) => ({
          source_plugin_id: source.plugin_id,
          last_ingested_at: source.last_seen_at,
        })),
        latest_sync_run: latestSyncRun
          ? { sync_run_id: latestSyncRun.sync_run_id }
          : null,
      },
    };
  });

  app.get("/api/v2/insights/latest", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return {
      daily_briefing: null,
      weekly_summary: null,
      recent_findings: [],
      runs: {
        daily_briefing: null,
        weekly_summary: null,
      },
    };
  });

  app.get("/api/v2/insights/findings", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return { findings: [], count: 0 };
  });

  app.get("/api/v2/insights/correlations", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return { correlations: [], count: 0 };
  });

  app.get<{
    Querystring: { type?: string; limit?: string };
  }>("/api/v2/insights/narratives", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const limit = parseLimit(request.query.limit, 1, 100) ?? 20;
    return { narratives: [], count: 0, limit };
  });

  app.post<{
    Body: InsightsTriggerBody | undefined;
  }>("/api/v2/insights/trigger", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const runType = request.body?.type ?? "daily_briefing";
    if (
      ![
        "correlation_analysis",
        "recovery_check",
        "daily_briefing",
        "weekly_summary",
      ].includes(runType)
    ) {
      return reply.code(400).send({ detail: `Unsupported type: ${runType}` });
    }

    return {
      status: "skipped",
      run_type: runType,
      message: "Analysis engine is not available in the MQTT bridge.",
      run_id: null,
    };
  });

  app.get("/api/v2/experiments/candidates", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return { candidates: [], count: 0, testable_count: 0 };
  });

  app.get("/api/v2/experiments", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const experiments = await options.readStore.listExperiments(
      options.context.name,
    );
    return { count: experiments.length, experiments };
  });

  app.post<{
    Body: Partial<CreateExperimentInput> | undefined;
  }>("/api/v2/experiments", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const input = request.body ?? {};
    if (
      typeof input.lever_metric_id !== "string" ||
      typeof input.outcome_metric_id !== "string"
    ) {
      return reply.code(422).send({
        detail: "lever_metric_id and outcome_metric_id are required",
      });
    }

    const experiment = await options.readStore.createExperiment(
      options.context.name,
      input as CreateExperimentInput,
    );
    return reply.code(201).send(experiment);
  });

  app.get<{
    Params: { experiment_id: string };
  }>("/api/v2/experiments/:experiment_id", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return experimentOr404(request, reply, options);
  });

  app.post<{
    Params: { experiment_id: string };
  }>("/api/v2/experiments/:experiment_id/analyze", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const experiment = await options.readStore.updateExperimentStatus(
      options.context.name,
      request.params.experiment_id,
      "analyzed",
    );
    return experiment ?? experimentNotFound(reply, request.params.experiment_id);
  });

  app.post<{
    Params: { experiment_id: string };
  }>("/api/v2/experiments/:experiment_id/abandon", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const experiment = await options.readStore.updateExperimentStatus(
      options.context.name,
      request.params.experiment_id,
      "abandoned",
    );
    return experiment ?? experimentNotFound(reply, request.params.experiment_id);
  });

  app.get("/api/v2/agents/proposals", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return { count: 0, undecided_only: true, proposals: [] };
  });

  app.post<{
    Params: { proposal_id: string };
    Body: DecideBody | undefined;
  }>("/api/v2/agents/proposals/:proposal_id/decide", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const decision = request.body?.decision;
    if (decision !== "approved" && decision !== "rejected") {
      return reply.code(422).send({ detail: "decision must be approved or rejected" });
    }

    return {
      proposal_id: request.params.proposal_id,
      decision,
      decided_by: "user",
      decision_id: null,
    };
  });

  app.get("/api/v2/export/metrics", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return options.readStore.listExportMetrics(options.context.name);
  });

  app.get<{
    Querystring: {
      metric?: string;
      format?: string;
      start?: string;
      end?: string;
      limit?: string;
    };
  }>("/api/v2/export", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const limit = parseLimit(request.query.limit, 1, 100_000) ?? 100_000;
    const metric = request.query.metric ?? "all";
    const observations = await options.readStore.listObservations(
      options.context.name,
      {
        metricId: metric === "all" ? undefined : metric,
        start: request.query.start,
        end: request.query.end,
        limit,
      },
    );
    const rows = observations.map(exportRowFromObservation);

    if (request.query.format === "csv") {
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .send(csvFromRows(rows));
    }

    return { count: rows.length, rows };
  });

  app.post<{
    Body: unknown;
  }>("/api/v2/sources/whoop/webhook", async (request, reply) => {
    const rawBody = webhookBodyText(request.body);
    if (options.config.whoopWebhookSecret) {
      const ok = verifyWhoopSignature({
        secret: options.config.whoopWebhookSecret,
        timestamp: headerString(request, "x-whoop-timestamp"),
        signature: headerString(request, "x-whoop-signature"),
        rawBody,
      });
      if (!ok) {
        return reply.code(401).send({ detail: "Invalid Whoop signature" });
      }
    } else {
      request.log.warn(
        "WHOOP_WEBHOOK_SECRET is not configured; accepting Whoop webhook as an unconfigured no-op",
      );
    }

    return {
      status: "accepted",
      received: true,
    };
  });
}

function contextPath(context: AppContextConfig, path: string): string {
  return context.prefix === "/" ? path : `${context.prefix}${path}`;
}

function emptyLatestSyncRunResponse() {
  return {
    status: "empty",
    sync_run_id: null,
    receipt_id: null,
    verification_level: "none",
    records_received: 0,
    records_accepted: 0,
    records_inserted_new: null,
    records_deduped_existing: null,
    storage_result_level: "accepted_only",
    records_skipped: 0,
    records_rejected: 0,
    records_deduped_in_batch: 0,
    sample_window: {
      min_sample_time: null,
      max_sample_time: null,
    },
    latest_sample_time: null,
    batches_seen: 0,
    batches_processed: 0,
    batches_failed: 0,
    metrics: [],
    oldest_received_at: null,
    newest_receipt_at: null,
  };
}

function resolveRange(query: TimeRangeQuery): {
  range: string;
  start: string;
  end: string;
} {
  const range = query.range ?? "7d";
  const end = normalizeDateTime(query.end) ?? new Date().toISOString();
  const start =
    normalizeDateTime(query.start) ??
    subtractRange(end, range) ??
    subtractRange(end, "7d")!;

  return { range, start, end };
}

function subtractRange(end: string, range: string): string | undefined {
  const match = /^(\d+)d$/.exec(range);
  if (!match) {
    return undefined;
  }

  const date = new Date(end);
  date.setUTCDate(date.getUTCDate() - Number.parseInt(match[1]!, 10));
  return date.toISOString();
}

function normalizeDateTime(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value.includes("T") ? value : `${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function pointFromObservation(observation: StoredObservation) {
  return {
    t: observation.t,
    value: observation.value,
    code: observation.code,
    unit: observation.unit ?? observation.canonical_unit,
    source_id: observation.source_id,
    stream_id: observation.stream_id,
    confidence: null,
  };
}

function exportRowFromObservation(observation: StoredObservation) {
  return {
    t: observation.t,
    metric_id: observation.metric_id,
    value: observation.value,
    code: observation.code,
    unit: observation.unit ?? observation.canonical_unit,
    source_id: observation.source_id,
    stream_id: observation.stream_id,
    ingested_at: observation.ingested_at,
  };
}

function dedupeIds(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
}

function parsePagination(query: PaginationQuery) {
  return {
    limit: parseLimit(query.limit, 1, 1_000),
    offset: parseOffset(query.offset),
  };
}

function parseLimit(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return undefined;
  }

  return Math.max(minimum, Math.min(maximum, parsed));
}

function parseOffset(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(0, parsed) : undefined;
}

function parseIntelligenceUpdate(
  body: Record<string, unknown> | undefined,
): UpdateIntelligenceInput {
  const input = body ?? {};
  const mode =
    input.mode === "off" || input.mode === "local" || input.mode === "cloud"
      ? input.mode
      : undefined;
  const primary =
    input.primary && typeof input.primary === "object" && !Array.isArray(input.primary)
      ? input.primary as Record<string, unknown>
      : undefined;

  return {
    mode,
    primary: primary
      ? {
          provider:
            typeof primary.provider === "string" ? primary.provider : undefined,
          model: typeof primary.model === "string" ? primary.model : undefined,
          base_url:
            typeof primary.base_url === "string" ? primary.base_url : undefined,
          api_key:
            typeof primary.api_key === "string" ? primary.api_key : undefined,
        }
      : undefined,
    redact_cloud_prompts:
      typeof input.redact_cloud_prompts === "boolean"
        ? input.redact_cloud_prompts
        : undefined,
    fallback: Array.isArray(input.fallback) ? [] : undefined,
  };
}

async function experimentOr404(
  request: FastifyRequest<{ Params: { experiment_id: string } }>,
  reply: FastifyReply,
  options: V2RouteOptions,
) {
  const experiment = await options.readStore.getExperiment(
    options.context.name,
    request.params.experiment_id,
  );
  return experiment ?? experimentNotFound(reply, request.params.experiment_id);
}

function experimentNotFound(reply: FastifyReply, experimentId: string) {
  return reply.code(404).send({
    status: "not_found",
    error: "Experiment not found",
    experiment_id: experimentId,
  });
}

function etagForObject(value: unknown): string {
  return `"${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32)}"`;
}

function csvFromRows(rows: Array<Record<string, unknown>>): string {
  const headers = [
    "t",
    "metric_id",
    "value",
    "code",
    "unit",
    "source_id",
    "stream_id",
    "ingested_at",
  ];
  return [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((header) => csvCell(row[header]))
        .join(","),
    ),
    "",
  ].join("\n");
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function webhookBodyText(body: unknown): string {
  return body === undefined ? "" : JSON.stringify(body);
}

function headerString(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
