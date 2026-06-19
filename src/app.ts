import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import {
  createMqttPublisher,
  type HealthMqttPublisher,
} from "./mqtt/publisher.js";
import { registerAppleRoutes } from "./routes/apple.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInsightRoutes } from "./routes/insights.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerV2Routes } from "./routes/v2.js";
import {
  createIdempotencyStore,
  type IdempotencyStore,
} from "./state/idempotency-store.js";
import {
  createSyncReceiptStore,
  type SyncReceiptStore,
} from "./state/sync-receipts.js";
import { createReadStore, type ReadStore } from "./state/read-store.js";
import { createStateStore, type StateStore } from "./state/store.js";
import {
  createRawBatchStorage,
  type RawBatchStorage,
} from "./storage/raw-batch-storage.js";

interface BuildAppOptions {
  config?: AppConfig;
  logger?: FastifyServerOptions["logger"];
  stateStore?: StateStore;
  mqttPublisher?: HealthMqttPublisher;
  rawBatchStorage?: RawBatchStorage;
  syncReceiptStore?: SyncReceiptStore;
  idempotencyStore?: IdempotencyStore;
  readStore?: ReadStore;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    bodyLimit: config.httpBodyLimitBytes,
    logger:
      options.logger ??
      (config.logEnabled
        ? {
            level: config.logLevel,
            redact: ["req.headers.x-api-key"],
          }
        : false),
  });
  const stateStore = options.stateStore ?? createStateStore(config, app.log);
  const mqttPublisher =
    options.mqttPublisher ?? (await createMqttPublisher(config));
  const rawBatchStorage =
    options.rawBatchStorage ?? createRawBatchStorage(config);
  const syncReceiptStore =
    options.syncReceiptStore ?? createSyncReceiptStore(config);
  const idempotencyStore =
    options.idempotencyStore ?? createIdempotencyStore(config);
  const readStore = options.readStore ?? createReadStore(config);

  app.setErrorHandler((error, _request, reply) => {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (errorCode === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.code(400).send({ detail: "invalid JSON body" });
    }

    return reply.send(error);
  });

  app.addHook("onClose", async () => {
    await Promise.all([mqttPublisher.close(), stateStore.close(), readStore.close()]);
  });

  for (const context of config.contexts) {
    await app.register(
      async (contextApp) => {
        await registerHealthRoutes(contextApp, {
          config,
          mqttPublisher,
          stateStore,
          readStore,
        });
        await registerMetricsRoutes(contextApp);
        await registerInsightRoutes(contextApp, { config });
        await registerAppleRoutes(contextApp, {
          config,
          context,
          stateStore,
          mqttPublisher,
          rawBatchStorage,
          syncReceiptStore,
          idempotencyStore,
          readStore,
        });
        await registerV2Routes(contextApp, {
          config,
          context,
          syncReceiptStore,
          readStore,
        });
      },
      { prefix: context.prefix === "/" ? "" : context.prefix },
    );
  }

  app.log.info("app ready");
  return app;
}
