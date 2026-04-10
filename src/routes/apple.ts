import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestApiKey, isAuthorized } from "../auth.js";
import type { AppConfig } from "../config.js";
import { batchRequestSchema, counterForMetric } from "../ingest.js";
import type { StateStore } from "../state/store.js";

interface AppleRouteOptions {
  config: AppConfig;
  stateStore: StateStore;
}

function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): boolean {
  if (isAuthorized(config, getRequestApiKey(request))) {
    return true;
  }

  reply.code(401).send({ detail: "Invalid API key" });
  return false;
}

export async function registerAppleRoutes(
  app: FastifyInstance,
  options: AppleRouteOptions,
): Promise<void> {
  app.post("/api/apple/batch", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    const parsed = batchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        status: "error",
        error: "Invalid batch payload",
        details: parsed.error.flatten(),
      });
    }

    const batch = parsed.data;
    if (batch.samples.length === 0) {
      return {
        status: "empty",
        metric: batch.metric,
        batch: batch.batch_index,
        records: 0,
      };
    }

    const records = batch.samples.length;
    await options.stateStore.increment(counterForMetric(batch.metric), records);

    return {
      status: "processed",
      metric: batch.metric,
      batch: batch.batch_index,
      total_batches: batch.total_batches,
      records,
    };
  });

  app.get("/api/apple/status", async (request, reply) => {
    if (!requireApiKey(request, reply, options.config)) {
      return reply;
    }

    return {
      status: "ok",
      counts: await options.stateStore.getCounts(),
    };
  });
}
