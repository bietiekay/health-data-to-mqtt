import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export interface MqttTopicConfig {
  raw: string;
  normalized: string;
  current: string;
}

export interface AppContextConfig {
  name: string;
  prefix: string;
  mqtt: {
    topics: MqttTopicConfig;
  };
}

export const DEFAULT_HTTP_BODY_LIMIT_BYTES = 500 * 1024 * 1024;

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

const topicConfigSchema = z.object({
  raw: z.string().optional(),
  normalized: z.string().optional(),
  current: z.string().optional(),
});

const contextConfigSchema = z.object({
  name: z.string().min(1),
  prefix: z.string().optional().default("/"),
  topics: topicConfigSchema.optional(),
});

const envSchema = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: integerFromEnv.default(8000),
    HTTP_BODY_LIMIT_BYTES: integerFromEnv
      .default(DEFAULT_HTTP_BODY_LIMIT_BYTES)
      .refine((value) => value > 0, {
        message: "HTTP body limit must be greater than 0",
      }),
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
    MQTT_TOPIC_CURRENT: z.string().default("healthsave/current/{metric}"),
    DATA_PATH: z.string().default("/data"),
    STATE_BACKEND: z.enum(["file", "memory"]).default("file"),
    RAW_STORAGE_PATH: z.string().optional().default(""),
  })
  .transform((env) => ({
    host: env.HOST,
    port: env.PORT,
    httpBodyLimitBytes: env.HTTP_BODY_LIMIT_BYTES,
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
        current: env.MQTT_TOPIC_CURRENT,
      },
    },
    dataPath: env.DATA_PATH.trim() || "/data",
    stateBackend: env.STATE_BACKEND,
    rawStoragePath:
      env.RAW_STORAGE_PATH.trim().length > 0
        ? env.RAW_STORAGE_PATH.trim()
        : undefined,
  }));

type BaseAppConfig = z.infer<typeof envSchema>;
export type AppConfig = BaseAppConfig & {
  contexts: AppContextConfig[];
};

const fileConfigSchema = z
  .object({
    http: z
      .object({
        host: z.string().optional(),
        port: z.number().int().optional(),
        bodyLimitBytes: z.number().int().positive().optional(),
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
            current: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    contexts: z.array(contextConfigSchema).optional(),
    state: z
      .object({
        backend: z.enum(["file", "memory"]).optional(),
      })
      .optional(),
    storage: z
      .object({
        dataPath: z.string().optional(),
        rawDataPath: z.string().optional(),
      })
      .optional(),
  })
  .default({});

type FileConfig = z.infer<typeof fileConfigSchema>;
type ContextConfigInput = z.infer<typeof contextConfigSchema>;

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
    HTTP_BODY_LIMIT_BYTES: config.http?.bodyLimitBytes?.toString(),
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
    MQTT_TOPIC_CURRENT: config.mqtt?.topics?.current,
    DATA_PATH: config.storage?.dataPath,
    STATE_BACKEND: config.state?.backend,
    RAW_STORAGE_PATH: config.storage?.rawDataPath,
  };
}

function removeUndefinedValues<T extends Record<string, unknown>>(
  env: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): boolean => {
      return entry[1] !== undefined;
    }),
  ) as Partial<T>;
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
  const fileConfig: FileConfig = options.configFilePath
    ? readConfigFile(options.configFilePath)
    : {};
  const configFileEnv = options.configFilePath ? fileConfigToEnv(fileConfig) : {};

  const baseConfig = envSchema.parse({
    ...removeUndefinedValues(configFileEnv),
    ...env,
  });

  return {
    ...baseConfig,
    contexts: buildContexts(
      baseConfig,
      parseContextsEnv(env.CONTEXTS) ?? fileConfig.contexts,
    ),
  };
}

function buildContexts(
  config: BaseAppConfig,
  inputs: ContextConfigInput[] | undefined,
): AppContextConfig[] {
  const defaultInput = inputs?.find((input) => {
    return input.name === "default" || normalizeContextPrefix(input.prefix) === "/";
  });
  const contexts: AppContextConfig[] = [
    createContextConfig("default", "/", config.mqtt.topics, defaultInput?.topics),
  ];

  for (const input of inputs ?? []) {
    const name = input.name.trim();
    const prefix = normalizeContextPrefix(input.prefix);

    if (name === "default" || prefix === "/") {
      continue;
    }

    contexts.push(
      createContextConfig(name, prefix, config.mqtt.topics, input.topics),
    );
  }

  assertUniqueContexts(contexts);
  return contexts;
}

function createContextConfig(
  name: string,
  prefix: string,
  defaults: MqttTopicConfig,
  overrides: Partial<MqttTopicConfig> | undefined,
): AppContextConfig {
  return {
    name,
    prefix,
    mqtt: {
      topics: {
        ...defaults,
        ...removeUndefinedValues(overrides ?? {}),
      },
    },
  };
}

function parseContextsEnv(
  contextsValue: string | undefined,
): ContextConfigInput[] | undefined {
  if (!contextsValue || contextsValue.trim().length === 0) {
    return undefined;
  }

  try {
    return z.array(contextConfigSchema).parse(JSON.parse(contextsValue));
  } catch (error) {
    throw new Error("Invalid CONTEXTS JSON configuration", { cause: error });
  }
}

function normalizeContextPrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "/").trim();
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function assertUniqueContexts(contexts: AppContextConfig[]): void {
  const names = new Set<string>();
  const prefixes = new Set<string>();

  for (const context of contexts) {
    if (names.has(context.name)) {
      throw new Error(`Duplicate context name: ${context.name}`);
    }

    if (prefixes.has(context.prefix)) {
      throw new Error(`Duplicate context prefix: ${context.prefix}`);
    }

    names.add(context.name);
    prefixes.add(context.prefix);
  }
}
