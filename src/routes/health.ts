import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { HealthMqttPublisher } from "../mqtt/publisher.js";
import { checkReadiness } from "../readiness.js";
import type { ReadStore } from "../state/read-store.js";
import type { StateStore } from "../state/store.js";

interface HealthRouteOptions {
  config: AppConfig;
  mqttPublisher: HealthMqttPublisher;
  stateStore: StateStore;
  readStore: ReadStore;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    const readiness = await checkReadiness(
      options.config,
      options.mqttPublisher,
      options.stateStore,
      options.readStore,
    );
    return reply.code(readiness.statusCode).send(readiness.body);
  });
}
