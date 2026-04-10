import { describe, expect, it } from "vitest";
import { isAuthorized } from "../../src/auth.js";

describe("isAuthorized", () => {
  it("accepts missing API keys when no API key is configured", () => {
    expect(isAuthorized({ apiKey: "" }, undefined)).toBe(true);
  });

  it("accepts matching API keys when an API key is configured", () => {
    expect(isAuthorized({ apiKey: "secret" }, "secret")).toBe(true);
  });

  it("rejects missing or incorrect API keys when an API key is configured", () => {
    expect(isAuthorized({ apiKey: "secret" }, undefined)).toBe(false);
    expect(isAuthorized({ apiKey: "secret" }, "wrong")).toBe(false);
  });
});
