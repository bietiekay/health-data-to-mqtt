import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireApiKey } from "../auth.js";
import type { AppConfig } from "../config.js";

interface InsightRouteOptions {
  config: AppConfig;
}

interface TriggerBody {
  type?: string;
}

export async function registerInsightRoutes(
  app: FastifyInstance,
  options: InsightRouteOptions,
): Promise<void> {
  app.get("/api/insights/latest", async (request, reply) => {
    if (!requireInsightApiKey(request, reply, options.config)) {
      return reply;
    }

    return {
      daily_briefing: null,
      weekly_summary: null,
      recent_findings: [],
    };
  });

  app.get("/api/insights/daily", async (request, reply) => {
    if (!requireInsightApiKey(request, reply, options.config)) {
      return reply;
    }

    return emptyDailyBriefing();
  });

  app.get("/api/insights/weekly", async (request, reply) => {
    if (!requireInsightApiKey(request, reply, options.config)) {
      return reply;
    }

    return emptyWeeklySummary();
  });

  app.get<{
    Querystring: { since?: string; severity?: string };
  }>("/api/insights/anomalies", async (request, reply) => {
    if (!requireInsightApiKey(request, reply, options.config)) {
      return reply;
    }

    if (request.query.since && !isParseableTimestamp(request.query.since)) {
      return reply.code(422).send({ detail: "Invalid since timestamp" });
    }

    const severities = parseCommaSeparated(request.query.severity);
    const invalidSeverities = severities.filter(
      (severity) => !["info", "watch", "alert"].includes(severity),
    );
    if (invalidSeverities.length > 0) {
      return reply.code(422).send({
        detail: `Invalid severity: ${invalidSeverities.join(", ")}. Allowed: alert, info, watch`,
      });
    }

    return {
      anomalies: [],
      count: 0,
    };
  });

  app.get<{
    Querystring: { period?: string };
  }>("/api/insights/trends", async (request, reply) => {
    if (!requireInsightApiKey(request, reply, options.config)) {
      return reply;
    }

    if (request.query.period && !isValidPeriod(request.query.period)) {
      return reply
        .code(422)
        .send({ detail: "Invalid period; expected format like 30d" });
    }

    return {
      trends: [],
      count: 0,
    };
  });

  app.post<{
    Body: TriggerBody | undefined;
  }>("/api/insights/trigger", async (request, reply) => {
    if (!requireInsightApiKey(request, reply, options.config)) {
      return reply;
    }

    const runType = request.body?.type ?? "daily_briefing";
    if (runType === "daily_briefing" || runType === "trend_analysis") {
      return {
        status: "skipped",
        run_type: runType,
        message: "Analysis engine is not available in the MQTT bridge.",
        run_id: null,
      };
    }

    return reply.code(400).send({ detail: `Unsupported type: ${runType}` });
  });

  app.get<{
    Querystring: { job_kind?: string; limit?: string };
  }>("/api/insights/runs", async (request, reply) => {
    if (!requireInsightApiKey(request, reply, options.config)) {
      return reply;
    }

    const limit = parseOptionalInteger(request.query.limit);
    if (request.query.limit !== undefined && (limit === undefined || limit < 1 || limit > 200)) {
      return reply.code(422).send({
        detail: [
          {
            type: "less_than_equal",
            loc: ["query", "limit"],
            msg: "Input should be less than or equal to 200",
            input: request.query.limit,
          },
        ],
      });
    }

    return {
      runs: [],
      count: 0,
    };
  });
}

function requireInsightApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): boolean {
  return requireApiKey(request, reply, config);
}

function emptyDailyBriefing() {
  return {
    id: null,
    date: null,
    narrative: null,
    findings: [],
    created_at: null,
  };
}

function emptyWeeklySummary() {
  return {
    id: null,
    week_start: null,
    week_end: null,
    narrative: null,
    findings: [],
    created_at: null,
  };
}

function isParseableTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value.replace(/Z$/, "+00:00")));
}

function parseCommaSeparated(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0);
}

function isValidPeriod(value: string): boolean {
  if (!value.endsWith("d")) {
    return false;
  }

  const days = Number.parseInt(value.slice(0, -1), 10);
  return Number.isInteger(days) && days > 0 && `${days}d` === value;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && String(parsed) === value
    ? parsed
    : undefined;
}
