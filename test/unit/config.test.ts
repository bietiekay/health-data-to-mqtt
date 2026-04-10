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
  it("loads local YAML configuration files", () => {
    const configPath = writeTempConfig(`
http:
  host: "127.0.0.1"
  port: 9000
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
`);

    const config = loadConfig({ env: {}, configFilePath: configPath });

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 9000,
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
      stateBackend: "memory",
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
auth:
  apiKey: "file-secret"
`);

    const config = loadConfig({
      env: {
        PORT: "9100",
        API_KEY: "env-secret",
      },
      configFilePath: configPath,
    });

    expect(config.port).toBe(9100);
    expect(config.apiKey).toBe("env-secret");
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
