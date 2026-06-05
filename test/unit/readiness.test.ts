import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { checkReadiness } from "../../src/readiness.js";

let tempDirectory: string | undefined;

function createTempDataPath(): string {
  tempDirectory = mkdtempSync(join(tmpdir(), "health-readiness-"));
  return tempDirectory;
}

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("checkReadiness", () => {
  it("returns reference-compatible success for memory state without MQTT", async () => {
    const config = loadConfig({
      STATE_BACKEND: "memory",
      MQTT_ENABLED: "false",
      LOG_ENABLED: "false",
    });

    await expect(checkReadiness(config, { isReady: () => false })).resolves.toEqual({
      statusCode: 200,
      body: {
        status: "ok",
        database: "ok",
      },
    });
  });

  it("probes file-backed state directories", async () => {
    const dataPath = createTempDataPath();
    const config = loadConfig({
      STATE_BACKEND: "file",
      DATA_PATH: dataPath,
      RAW_STORAGE_PATH: join(dataPath, "raw"),
      MQTT_ENABLED: "false",
      LOG_ENABLED: "false",
    });

    await expect(checkReadiness(config, { isReady: () => true })).resolves.toEqual({
      statusCode: 200,
      body: {
        status: "ok",
        database: "ok",
      },
    });
  });

  it("returns unavailable while the state store is not ready", async () => {
    const dataPath = createTempDataPath();
    const config = loadConfig({
      STATE_BACKEND: "file",
      DATA_PATH: dataPath,
      MQTT_ENABLED: "false",
      LOG_ENABLED: "false",
    });

    await expect(
      checkReadiness(config, { isReady: () => true }, { isReady: () => false }),
    ).resolves.toEqual({
      statusCode: 503,
      body: {
        detail: "database unavailable",
        database: "unavailable",
      },
    });
  });

  it("returns unavailable when file-backed state cannot be probed", async () => {
    const config = loadConfig({
      STATE_BACKEND: "file",
      DATA_PATH: "/dev/null",
      MQTT_ENABLED: "false",
      LOG_ENABLED: "false",
    });

    await expect(checkReadiness(config, { isReady: () => true })).resolves.toEqual({
      statusCode: 503,
      body: {
        detail: "database unavailable",
        database: "unavailable",
      },
    });
  });

  it("keeps V1 readiness independent from MQTT state", async () => {
    const config = loadConfig({
      STATE_BACKEND: "memory",
      MQTT_ENABLED: "true",
      LOG_ENABLED: "false",
    });

    await expect(checkReadiness(config, { isReady: () => false })).resolves.toEqual({
      statusCode: 200,
      body: {
        status: "ok",
        database: "ok",
      },
    });
  });
});
