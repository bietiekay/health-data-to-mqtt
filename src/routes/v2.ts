import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../auth.js";
import type { AppConfig, AppContextConfig } from "../config.js";
import type { SyncReceiptStore } from "../state/sync-receipts.js";

interface V2RouteOptions {
  config: AppConfig;
  context: AppContextConfig;
  syncReceiptStore: SyncReceiptStore;
}

export async function registerV2Routes(
  app: FastifyInstance,
  options: V2RouteOptions,
): Promise<void> {
  app.get("/api/v2/setup/diagnostics", async () => {
    return {
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
      grafana_required: false,
      wrong_port_hint:
        "If you see Grafana auth JSON, Homepage HTML, or an MQTT broker response, the app is pointed at the wrong port. Use the Health Data to MQTT API base URL.",
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
      return reply.code(404).send({
        status: "not_found",
        error: "No sync runs have been recorded",
      });
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
}

function contextPath(context: AppContextConfig, path: string): string {
  return context.prefix === "/" ? path : `${context.prefix}${path}`;
}
