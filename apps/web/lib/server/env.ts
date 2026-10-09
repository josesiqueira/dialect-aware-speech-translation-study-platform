// Environment validation for the web app (spec 95, 26, 67).
//
// Usage: `const env = getEnv();` in server code. The first call parses and
// validates process.env and caches the result. A failed validation throws an
// EnvValidationError whose message lists variable names and reasons, never values.
import "server-only";
import { z } from "zod";

const booleanText = z
  .enum(["true", "false", "1", "0"], { error: 'must be "true" or "false"' })
  .transform((value) => value === "true" || value === "1");

const positiveInt = (fallback: number) =>
  z.coerce
    .number({ error: "must be a number" })
    .int("must be a whole number")
    .positive("must be greater than zero")
    .default(fallback);

const positiveNumber = (fallback: number) =>
  z.coerce
    .number({ error: "must be a number" })
    .positive("must be greater than zero")
    .default(fallback);

// The version label used when APP_VERSION is not set outside production.
export const DEVELOPMENT_APP_VERSION = "dev";

const envSchema = z
  .object({
    // App
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.url("must be an absolute URL such as http://localhost:3000").default("http://localhost:3000"),
    // Recorded with every session and model run (provenance). Outside production
    // it defaults to "dev". In production it must be set to a real version.
    APP_VERSION: z.string().optional(),
    GIT_COMMIT_SHA: z.string().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),

    // Database
    DATABASE_URL: z
      .string({ error: "is required" })
      .regex(/^postgres(ql)?:\/\//, "must be a postgresql:// connection string"),

    // Admin authentication (spec 39)
    ADMIN_PASSWORD: z.string({ error: "is required" }).min(1, "is required"),
    ADMIN_SESSION_SECRET: z
      .string({ error: "is required" })
      .min(32, "must be at least 32 characters (generate with: openssl rand -base64 48)"),
    ADMIN_SESSION_TTL_HOURS: positiveNumber(8),
    PARTICIPANT_SESSION_TTL_HOURS: positiveNumber(24),
    TRUST_PROXY: booleanText.default(false),

    // AI providers. Collection works without a key (spec 29).
    OPENAI_API_KEY: z.string().optional(),
    AI_ALLOW_MOCK_PROVIDER: booleanText.optional(),

    // Storage
    STORAGE_DRIVER: z.enum(["local", "s3"], { error: 'must be "local" or "s3"' }).default("local"),
    LOCAL_STORAGE_ROOT: z.string().default("./data/media"),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanText.default(false),

    // Upload and audio limits
    MAX_AUDIO_UPLOAD_MB: positiveInt(100),
    MAX_UTTERANCE_SECONDS: positiveInt(300),

    // Worker (read by the worker process; validated here so one file documents every variable)
    WORKER_ID: z.string().default("worker-1"),
    WORKER_POLL_INTERVAL_MS: positiveInt(2000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && (!env.APP_VERSION || env.APP_VERSION === DEVELOPMENT_APP_VERSION)) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_VERSION"],
        message: 'must be set to the released version in production (it is recorded with every session and model run, and must not be "dev")',
      });
    }
    if (env.NODE_ENV === "production" && env.ADMIN_PASSWORD.length < 12) {
      ctx.addIssue({
        code: "custom",
        path: ["ADMIN_PASSWORD"],
        message: "must be at least 12 characters in production",
      });
    }
    if (env.STORAGE_DRIVER === "s3") {
      for (const name of ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
        if (!env[name]) {
          ctx.addIssue({ code: "custom", path: [name], message: 'is required when STORAGE_DRIVER is "s3"' });
        }
      }
    }
  })
  .transform((env) => ({
    ...env,
    APP_VERSION: env.APP_VERSION ?? DEVELOPMENT_APP_VERSION,
    GIT_COMMIT_SHA: env.GIT_COMMIT_SHA ?? null,
    // The mock AI provider is allowed by default everywhere except production.
    AI_ALLOW_MOCK_PROVIDER: env.AI_ALLOW_MOCK_PROVIDER ?? env.NODE_ENV !== "production",
    isProduction: env.NODE_ENV === "production",
  }));

export type Env = z.output<typeof envSchema>;

export type EnvIssue = { variable: string; message: string };

export class EnvValidationError extends Error {
  readonly issues: EnvIssue[];

  constructor(issues: EnvIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);
    super(`Invalid environment configuration:\n${lines.join("\n")}\nSee .env.example for every variable.`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

// Names of the variables whose values must never be logged or returned.
export const SECRET_ENV_NAMES = [
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "OPENAI_API_KEY",
  "S3_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
] as const;

// Pure parser: validates the given source. An empty string counts as "not set",
// because .env files list optional variables as `NAME=`.
export function parseEnv(source: Record<string, string | undefined>): Env {
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(envSchema.in.shape)) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") cleaned[key] = value.trim();
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    // Only variable names and fixed messages: a Zod message never contains the received value here.
    const issues = result.error.issues.map((issue) => ({
      variable: issue.path.length > 0 ? String(issue.path[0]) : "(environment)",
      message: issue.message,
    }));
    throw new EnvValidationError(issues);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Configuration warnings
// ---------------------------------------------------------------------------

// A setting that is valid but risky for the way the app is deployed. A warning
// never stops the server. It is logged at startup and counted (without detail)
// by GET /api/health/ready.
export type ConfigurationWarning = { code: string; message: string };

// True for http://localhost, 127.0.0.0/8, [::1] and names under .localhost.
export function isLocalAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export function configurationWarnings(env: Pick<Env, "APP_URL" | "TRUST_PROXY">): ConfigurationWarning[] {
  const warnings: ConfigurationWarning[] = [];
  if (!env.TRUST_PROXY && !isLocalAddress(env.APP_URL)) {
    warnings.push({
      code: "TRUST_PROXY_OFF_ON_PUBLIC_URL",
      message:
        "APP_URL is a public address and TRUST_PROXY is false: the app cannot tell clients apart, so every client shares one rate limit bucket. " +
        "A single client can use up the limit for new participant sessions for everyone. " +
        "Put exactly one trusted reverse proxy in front of the app and set TRUST_PROXY=true (docs/DEPLOYMENT.md).",
    });
  }
  return warnings;
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

// Tests change process.env between cases and call this to force a new parse.
export function resetEnvCacheForTests(): void {
  cached = null;
}
