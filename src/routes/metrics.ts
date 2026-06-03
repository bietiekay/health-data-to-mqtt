import type { FastifyInstance } from "fastify";
import { Counter, Histogram, Registry } from "prom-client";

const registry = new Registry();

const metricNames = [
  "hdh_ingest_batches",
  "hdh_ingest_rows",
  "hdh_ai_briefing_runs",
  "hdh_ingest_duration_seconds",
  "hdh_ingest_rejected_rows",
  "hdh_raw_log_orphaned",
  "hdh_status_query_failures",
  "hdh_pipeline_runs_ledger_failures",
  "hdh_ledger_listener_failures",
  "hdh_canonical_dual_write",
] as const;

new Counter({
  name: "hdh_ingest_batches",
  help: "Number of ingest batches accepted by the API.",
  labelNames: ["metric"],
  registers: [registry],
}).labels("unknown").inc(0);

new Counter({
  name: "hdh_ingest_rows",
  help: "Number of rows processed by the ingest API.",
  labelNames: ["metric"],
  registers: [registry],
}).labels("unknown").inc(0);

new Counter({
  name: "hdh_ai_briefing_runs",
  help: "Analysis job runs partitioned by job and result.",
  labelNames: ["job", "result"],
  registers: [registry],
}).labels("unknown", "unknown").inc(0);

new Histogram({
  name: "hdh_ingest_duration_seconds",
  help: "End-to-end ingest handler duration in seconds.",
  labelNames: ["metric"],
  registers: [registry],
}).labels("unknown").observe(0);

new Counter({
  name: "hdh_ingest_rejected_rows",
  help: "Per-batch rows that the ingest path silently dropped.",
  labelNames: ["metric", "reason"],
  registers: [registry],
}).labels("unknown", "unknown").inc(0);

new Counter({
  name: "hdh_raw_log_orphaned",
  help: "Raw ingestion log rows left unprocessed after ingest failure.",
  labelNames: ["metric"],
  registers: [registry],
}).labels("unknown").inc(0);

new Counter({
  name: "hdh_status_query_failures",
  help: "GET /api/apple/status per-metric query failures.",
  labelNames: ["metric", "exception"],
  registers: [registry],
}).labels("unknown", "unknown").inc(0);

new Counter({
  name: "hdh_pipeline_runs_ledger_failures",
  help: "Failures writing to the pipeline runs ledger.",
  labelNames: ["phase"],
  registers: [registry],
}).labels("unknown").inc(0);

new Counter({
  name: "hdh_ledger_listener_failures",
  help: "Failures inside the worker scheduler ledger listener.",
  labelNames: ["phase"],
  registers: [registry],
}).labels("unknown").inc(0);

new Counter({
  name: "hdh_canonical_dual_write",
  help: "Canonical observation dual-write outcomes.",
  labelNames: ["metric", "result"],
  registers: [registry],
}).labels("unknown", "unknown").inc(0);

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (_request, reply) => {
    const body = await registry.metrics();
    return reply
      .header("content-type", registry.contentType)
      .send(ensureMetricNames(body));
  });
}

function ensureMetricNames(body: string): string {
  const missingNames = metricNames.filter((name) => !body.includes(name));
  if (missingNames.length === 0) {
    return body;
  }

  return [
    body.trimEnd(),
    ...missingNames.map((name) => `# HELP ${name} compatibility placeholder\n# TYPE ${name} counter`),
    "",
  ].join("\n");
}
