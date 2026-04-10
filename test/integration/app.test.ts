import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const baseConfig = loadConfig({
  HOST: "127.0.0.1",
  PORT: "0",
  LOG_ENABLED: "false",
  API_KEY: "",
});

let app: FastifyInstance | undefined;

async function createApp(apiKey = "") {
  app = await buildApp({
    config: {
      ...baseConfig,
      apiKey,
      logEnabled: false,
    },
  });

  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("compatibility endpoints", () => {
  it("returns health responses", async () => {
    const server = await createApp();

    await expect(server.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({
      statusCode: 200,
      json: expect.any(Function),
    });

    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("accepts batches without an API key when auth is disabled", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        batch_index: 0,
        total_batches: 1,
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 72 }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "processed",
      metric: "heart_rate",
      batch: 0,
      total_batches: 1,
      records: 1,
    });
  });

  it("returns the reference-compatible empty batch response", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate",
        batch_index: 0,
        total_batches: 1,
        samples: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "empty",
      metric: "heart_rate",
      batch: 0,
      records: 0,
    });
  });

  it("tracks status counters for processed batches", async () => {
    const server = await createApp();

    await server.inject({
      method: "POST",
      url: "/api/apple/batch",
      payload: {
        metric: "heart_rate_variability",
        samples: [{ date: "2026-04-10T12:00:00Z", qty: 44 }],
      },
    });

    const response = await server.inject({ method: "GET", url: "/api/apple/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      counts: {
        heart_rate: 0,
        hrv: 1,
        blood_oxygen: 0,
        daily_activity: 0,
        sleep_sessions: 0,
        workouts: 0,
        quantity_samples: 0,
      },
    });
  });

  it("requires the configured API key on protected endpoints", async () => {
    const server = await createApp("secret");

    const unauthorized = await server.inject({
      method: "GET",
      url: "/api/apple/status",
      headers: { "x-api-key": "wrong" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ detail: "Invalid API key" });

    const authorized = await server.inject({
      method: "GET",
      url: "/api/apple/status",
      headers: { "x-api-key": "secret" },
    });

    expect(authorized.statusCode).toBe(200);
  });
});
