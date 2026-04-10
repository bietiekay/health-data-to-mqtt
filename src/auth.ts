import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

export function isAuthorized(
  config: Pick<AppConfig, "apiKey">,
  providedApiKey: string | undefined,
): boolean {
  if (!config.apiKey) {
    return true;
  }

  return providedApiKey === config.apiKey;
}

export function getRequestApiKey(request: FastifyRequest): string | undefined {
  const header = request.headers["x-api-key"];

  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}
