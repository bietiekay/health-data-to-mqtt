import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

let tempDirectory: string | undefined;

function writeTempConfig(content: string): string {
  tempDirectory = mkdtempSync(join(tmpdir(), "health-data-to-mqtt-"));
  const configPath = join(tempDirectory, "app.config.yaml");
  writeFileSync(configPath, content);
  return configPath;
}

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("loadConfig", () => {
  it("uses a 500 MiB default HTTP body limit", () => {
    const config = loadConfig({});

    expect(config.httpBodyLimitBytes).toBe(500 * 1024 * 1024);
  });

  it("loads local YAML configuration files", () => {
    const configPath = writeTempConfig(`
http:
  host: "127.0.0.1"
  port: 9000
  bodyLimitBytes: 1234567
auth:
  apiKey: "local-secret"
logging:
  enabled: false
  level: "debug"
mqtt:
  enabled: false
  url: "mqtt://localhost:1883"
  clientId: "local-client"
  qos: 0
  retain: true
  topics:
    raw: "local/raw/{metric}"
    normalized: "local/normalized/{metric}"
    current: "local/current/{metric}"
contexts:
  - name: "daniel"
    prefix: "/daniel"
    topics:
      raw: "daniel/raw/{metric}"
      normalized: "daniel/normalized/{metric}"
      current: "daniel/current/{metric}"
state:
  backend: "memory"
storage:
  dataPath: "/tmp/health-data"
  rawDataPath: "/tmp/health-raw"
`);

    const config = loadConfig({ env: {}, configFilePath: configPath });

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 9000,
      httpBodyLimitBytes: 1234567,
      apiKey: "local-secret",
      logEnabled: false,
      logLevel: "debug",
      mqtt: {
        enabled: false,
        url: "mqtt://localhost:1883",
        clientId: "local-client",
        qos: 0,
        retain: true,
        topics: {
          raw: "local/raw/{metric}",
          normalized: "local/normalized/{metric}",
          current: "local/current/{metric}",
        },
      },
      dataPath: "/tmp/health-data",
      stateBackend: "memory",
      rawStoragePath: "/tmp/health-raw",
      contexts: [
        {
          name: "default",
          prefix: "/",
          mqtt: {
            topics: {
              raw: "local/raw/{metric}",
              normalized: "local/normalized/{metric}",
              current: "local/current/{metric}",
            },
          },
        },
        {
          name: "daniel",
          prefix: "/daniel",
          mqtt: {
            topics: {
              raw: "daniel/raw/{metric}",
              normalized: "daniel/normalized/{metric}",
              current: "daniel/current/{metric}",
            },
          },
        },
      ],
    });
  });

  it("lets environment variables override local config files", () => {
    const configPath = writeTempConfig(`
http:
  port: 9000
  bodyLimitBytes: 1234567
auth:
  apiKey: "file-secret"
storage:
  dataPath: "/tmp/file-data"
  rawDataPath: "/tmp/file-raw"
`);

    const config = loadConfig({
      env: {
        PORT: "9100",
        HTTP_BODY_LIMIT_BYTES: "7654321",
        API_KEY: "env-secret",
        DATA_PATH: "/tmp/env-data",
        RAW_STORAGE_PATH: "/tmp/env-raw",
      },
      configFilePath: configPath,
    });

    expect(config.port).toBe(9100);
    expect(config.httpBodyLimitBytes).toBe(7654321);
    expect(config.apiKey).toBe("env-secret");
    expect(config.dataPath).toBe("/tmp/env-data");
    expect(config.rawStoragePath).toBe("/tmp/env-raw");
  });

  it("loads the data path from environment variables", () => {
    const config = loadConfig({
      DATA_PATH: "/data",
    });

    expect(config.dataPath).toBe("/data");
  });

  it("loads raw storage paths from environment variables", () => {
    const config = loadConfig({
      RAW_STORAGE_PATH: "/data/raw",
    });

    expect(config.rawStoragePath).toBe("/data/raw");
  });

  it("treats empty raw storage paths as disabled", () => {
    const config = loadConfig({
      RAW_STORAGE_PATH: " ",
    });

    expect(config.rawStoragePath).toBeUndefined();
  });

  it("loads contexts from environment JSON", () => {
    const config = loadConfig({
      CONTEXTS: JSON.stringify([
        {
          name: "alice",
          prefix: "alice",
          topics: {
            raw: "healthsave/{context}/raw/{metric}",
            normalized: "healthsave/{context}/normalized/{metric}",
            current: "healthsave/{context}/current/{metric}",
          },
        },
      ]),
    });

    expect(config.contexts).toMatchObject([
      {
        name: "default",
        prefix: "/",
      },
      {
        name: "alice",
        prefix: "/alice",
        mqtt: {
          topics: {
            raw: "healthsave/{context}/raw/{metric}",
            normalized: "healthsave/{context}/normalized/{metric}",
            current: "healthsave/{context}/current/{metric}",
          },
        },
      },
    ]);
  });
});
