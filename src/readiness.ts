import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { HealthMqttPublisher } from "./mqtt/publisher.js";

export interface ReadyResponse {
  status: "ok" | "error";
  database: "ok" | "unavailable";
  mqtt?: "ok" | "unavailable";
}

export async function checkReadiness(
  config: AppConfig,
  mqttPublisher: Pick<HealthMqttPublisher, "isReady">,
): Promise<{ statusCode: 200 | 503; body: ReadyResponse }> {
  const databaseReady = await isStateReady(config);
  const mqttReady = !config.mqtt.enabled || mqttPublisher.isReady();

  if (databaseReady && mqttReady) {
    return {
      statusCode: 200,
      body: {
        status: "ok",
        database: "ok",
        ...(config.mqtt.enabled ? { mqtt: "ok" as const } : {}),
      },
    };
  }

  return {
    statusCode: 503,
    body: {
      status: "error",
      database: databaseReady ? "ok" : "unavailable",
      ...(config.mqtt.enabled
        ? { mqtt: mqttReady ? "ok" as const : "unavailable" as const }
        : {}),
    },
  };
}

async function isStateReady(config: AppConfig): Promise<boolean> {
  if (config.stateBackend === "memory") {
    return true;
  }

  const probeDirectories = [
    join(config.dataPath, "status"),
    join(config.dataPath, "receipts"),
    join(config.dataPath, "idempotency"),
    ...(config.rawStoragePath ? [config.rawStoragePath] : []),
  ];

  try {
    await Promise.all(probeDirectories.map(probeWritableDirectory));
    return true;
  } catch {
    return false;
  }
}

async function probeWritableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const probePath = join(
    directory,
    `.health-data-to-mqtt-ready-${process.pid}-${Date.now()}`,
  );
  await writeFile(probePath, "ok", { flag: "wx" });
  await unlink(probePath);
}
