import { z } from "zod";

const booleanFromEnv = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }

    if (value === undefined || value === "") {
      return undefined;
    }

    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  });

const integerFromEnv = z
  .union([z.number(), z.string(), z.undefined()])
  .transform((value, context) => {
    if (value === undefined || value === "") {
      return undefined;
    }

    const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected an integer",
      });
      return z.NEVER;
    }

    return parsed;
  });

const envSchema = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: integerFromEnv.default(8000),
    API_KEY: z.string().optional().default(""),
    LOG_ENABLED: booleanFromEnv.default(true),
    LOG_LEVEL: z.string().default("info"),
    MQTT_ENABLED: booleanFromEnv.default(true),
    MQTT_URL: z.string().url().default("mqtt://broker:1883"),
    MQTT_CLIENT_ID: z.string().default("healthsave-proxy"),
    MQTT_USERNAME: z.string().optional().default(""),
    MQTT_PASSWORD: z.string().optional().default(""),
    MQTT_QOS: integerFromEnv.default(1),
    MQTT_RETAIN: booleanFromEnv.default(false),
    MQTT_TOPIC_RAW: z.string().default("healthsave/raw/{metric}"),
    MQTT_TOPIC_NORMALIZED: z
      .string()
      .default("healthsave/normalized/{metric}"),
    STATE_BACKEND: z.enum(["memory", "sqlite", "redis"]).default("memory"),
  })
  .transform((env) => ({
    host: env.HOST,
    port: env.PORT,
    apiKey: env.API_KEY,
    logEnabled: env.LOG_ENABLED,
    logLevel: env.LOG_LEVEL,
    mqtt: {
      enabled: env.MQTT_ENABLED,
      url: env.MQTT_URL,
      clientId: env.MQTT_CLIENT_ID,
      username: env.MQTT_USERNAME || undefined,
      password: env.MQTT_PASSWORD || undefined,
      qos: env.MQTT_QOS,
      retain: env.MQTT_RETAIN,
      topics: {
        raw: env.MQTT_TOPIC_RAW,
        normalized: env.MQTT_TOPIC_NORMALIZED,
      },
    },
    stateBackend: env.STATE_BACKEND,
  }));

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
