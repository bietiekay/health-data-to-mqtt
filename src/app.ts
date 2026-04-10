import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import {
  createMqttPublisher,
  type HealthMqttPublisher,
} from "./mqtt/publisher.js";
import { registerAppleRoutes } from "./routes/apple.js";
import { registerHealthRoutes } from "./routes/health.js";
import { createStateStore, type StateStore } from "./state/store.js";
import {
  createRawBatchStorage,
  type RawBatchStorage,
} from "./storage/raw-batch-storage.js";

interface BuildAppOptions {
  config?: AppConfig;
  stateStore?: StateStore;
  mqttPublisher?: HealthMqttPublisher;
  rawBatchStorage?: RawBatchStorage;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const stateStore = options.stateStore ?? createStateStore(config);
  const mqttPublisher =
    options.mqttPublisher ?? (await createMqttPublisher(config));
  const rawBatchStorage =
    options.rawBatchStorage ?? createRawBatchStorage(config);

  const app = Fastify({
    bodyLimit: config.httpBodyLimitBytes,
    logger: config.logEnabled
      ? {
          level: config.logLevel,
          redact: ["req.headers.x-api-key"],
        }
      : false,
  });

  app.addHook("onClose", async () => {
    await mqttPublisher.close();
  });

  for (const context of config.contexts) {
    await app.register(
      async (contextApp) => {
        await registerHealthRoutes(contextApp);
        await registerAppleRoutes(contextApp, {
          config,
          context,
          stateStore,
          mqttPublisher,
          rawBatchStorage,
        });
      },
      { prefix: context.prefix === "/" ? "" : context.prefix },
    );
  }

  return app;
}
