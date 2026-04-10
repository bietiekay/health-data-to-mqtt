import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
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

const fileConfigSchema = z
  .object({
    http: z
      .object({
        host: z.string().optional(),
        port: z.number().int().optional(),
      })
      .optional(),
    auth: z
      .object({
        apiKey: z.string().optional(),
      })
      .optional(),
    logging: z
      .object({
        enabled: z.boolean().optional(),
        level: z.string().optional(),
      })
      .optional(),
    mqtt: z
      .object({
        enabled: z.boolean().optional(),
        url: z.string().optional(),
        clientId: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
        qos: z.number().int().optional(),
        retain: z.boolean().optional(),
        topics: z
          .object({
            raw: z.string().optional(),
            normalized: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    state: z
      .object({
        backend: z.enum(["memory", "sqlite", "redis"]).optional(),
      })
      .optional(),
  })
  .default({});

type FileConfig = z.infer<typeof fileConfigSchema>;

interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  configFilePath?: string;
}

function readConfigFile(configFilePath: string): FileConfig {
  const content = readFileSync(configFilePath, "utf8");
  return fileConfigSchema.parse(parseYaml(content) ?? {});
}

function fileConfigToEnv(config: FileConfig): Partial<NodeJS.ProcessEnv> {
  return {
    HOST: config.http?.host,
    PORT: config.http?.port?.toString(),
    API_KEY: config.auth?.apiKey,
    LOG_ENABLED: config.logging?.enabled?.toString(),
    LOG_LEVEL: config.logging?.level,
    MQTT_ENABLED: config.mqtt?.enabled?.toString(),
    MQTT_URL: config.mqtt?.url,
    MQTT_CLIENT_ID: config.mqtt?.clientId,
    MQTT_USERNAME: config.mqtt?.username,
    MQTT_PASSWORD: config.mqtt?.password,
    MQTT_QOS: config.mqtt?.qos?.toString(),
    MQTT_RETAIN: config.mqtt?.retain?.toString(),
    MQTT_TOPIC_RAW: config.mqtt?.topics?.raw,
    MQTT_TOPIC_NORMALIZED: config.mqtt?.topics?.normalized,
    STATE_BACKEND: config.state?.backend,
  };
}

function removeUndefinedValues(
  env: Partial<NodeJS.ProcessEnv>,
): Partial<NodeJS.ProcessEnv> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
}

function isLoadConfigOptions(
  input: NodeJS.ProcessEnv | LoadConfigOptions,
): input is LoadConfigOptions {
  return (
    Object.hasOwn(input, "env") || Object.hasOwn(input, "configFilePath")
  );
}

export function loadConfig(
  input: NodeJS.ProcessEnv | LoadConfigOptions = process.env,
): AppConfig {
  const options: LoadConfigOptions = isLoadConfigOptions(input)
    ? input
    : { env: input };
  const env = options.env ?? process.env;
  const configFileEnv = options.configFilePath
    ? fileConfigToEnv(readConfigFile(options.configFilePath))
    : {};

  return envSchema.parse({
    ...removeUndefinedValues(configFileEnv),
    ...env,
  });
}
