import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

function getConfigFilePath(args: string[]): string | undefined {
  const configIndex = args.findIndex((arg) => arg === "--config" || arg === "-c");
  if (configIndex === -1) {
    return undefined;
  }

  const configFilePath = args[configIndex + 1];
  if (!configFilePath) {
    throw new Error("Missing value for --config");
  }

  return configFilePath;
}

const config = loadConfig({
  configFilePath: getConfigFilePath(process.argv.slice(2)),
});
const app = await buildApp({ config });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
