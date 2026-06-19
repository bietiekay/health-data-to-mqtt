import { createHmac, timingSafeEqual } from "node:crypto";

export function createWhoopSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}${rawBody}`)
    .digest("base64");
}

export function verifyWhoopSignature(input: {
  secret: string;
  timestamp: string | undefined;
  rawBody: string;
  signature: string | undefined;
}): boolean {
  if (!input.timestamp || !input.signature) {
    return false;
  }

  const expected = Buffer.from(
    createWhoopSignature(input.secret, input.timestamp, input.rawBody),
  );
  const provided = Buffer.from(input.signature);

  return (
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}
