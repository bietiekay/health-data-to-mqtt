import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { registerAppleRoutes } from "./routes/apple.js";
import { registerHealthRoutes } from "./routes/health.js";
import { createMemoryStateStore, type StateStore } from "./state/store.js";

interface BuildAppOptions {
  config?: AppConfig;
  stateStore?: StateStore;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const stateStore = options.stateStore ?? createMemoryStateStore();

  const app = Fastify({
    logger: config.logEnabled
      ? {
          level: config.logLevel,
          redact: ["req.headers.x-api-key"],
        }
      : false,
  });

  await registerHealthRoutes(app);
  await registerAppleRoutes(app, { config, stateStore });

  return app;
}
