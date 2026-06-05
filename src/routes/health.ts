import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { HealthMqttPublisher } from "../mqtt/publisher.js";
import { checkReadiness } from "../readiness.js";
import type { StateStore } from "../state/store.js";

interface HealthRouteOptions {
  config: AppConfig;
  mqttPublisher: HealthMqttPublisher;
  stateStore: StateStore;
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
    );
    return reply.code(readiness.statusCode).send(readiness.body);
  });
}
