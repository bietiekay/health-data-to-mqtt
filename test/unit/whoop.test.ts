import { describe, expect, it } from "vitest";
import {
  createWhoopSignature,
  verifyWhoopSignature,
} from "../../src/webhooks/whoop.js";

describe("Whoop webhook signatures", () => {
  it("verifies base64 HMAC signatures over timestamp plus body", () => {
    const secret = "secret";
    const timestamp = "2026-06-19T12:00:00Z";
    const rawBody = JSON.stringify({ event: "workout.updated" });
    const signature = createWhoopSignature(secret, timestamp, rawBody);

    expect(
      verifyWhoopSignature({ secret, timestamp, rawBody, signature }),
    ).toBe(true);
    expect(
      verifyWhoopSignature({
        secret,
        timestamp,
        rawBody: JSON.stringify({ event: "tampered" }),
        signature,
      }),
    ).toBe(false);
    expect(
      verifyWhoopSignature({
        secret,
        timestamp: undefined,
        rawBody,
        signature,
      }),
    ).toBe(false);
  });
});
