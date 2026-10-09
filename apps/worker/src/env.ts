// Environment validation for the worker process (spec 95).
//
// `parseWorkerEnv(process.env)` validates once at startup. A failed validation
// throws a WorkerEnvError whose message lists variable names and reasons, never
// values. The storage variables are checked here for early, readable errors;
// `storageConfigFromEnv` from @dialect/storage reads them again to build the driver.
import { hostname } from "node:os";
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

// The version label used when APP_VERSION is not set outside production.
export const DEVELOPMENT_APP_VERSION = "dev";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Recorded with every model run (provenance). Outside production it defaults
    // to "dev". In production it must be set to the released version.
    APP_VERSION: z.string().optional(),
    GIT_COMMIT_SHA: z.string().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    DATABASE_URL: z
      .string({ error: "is required" })
      .regex(/^postgres(ql)?:\/\//, "must be a postgresql:// connection string"),

    // AI providers. The worker starts without a key: jobs that need the provider
    // then fail with CONFIGURATION_MISSING and can be retried later (spec 29).
    OPENAI_API_KEY: z.string().optional(),
    AI_ALLOW_MOCK_PROVIDER: booleanText.optional(),

    // Storage
    STORAGE_DRIVER: z.enum(["local", "s3"], { error: 'must be "local" or "s3"' }).default("local"),
    LOCAL_STORAGE_ROOT: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanText.default(false),

    // Worker. Replicas need different ids; without WORKER_ID the host name is
    // used, which is the pod name in a container platform.
    WORKER_ID: z.string().max(200, "must be at most 200 characters").optional(),
    WORKER_POLL_INTERVAL_MS: positiveInt(2000),
    WORKER_CONCURRENCY: positiveInt(1).pipe(z.number().max(16, "must be at most 16")),
    WORKER_LOCK_TIMEOUT_MS: positiveInt(600_000),
    WORKER_HEARTBEAT_INTERVAL_MS: positiveInt(10_000),
    WORKER_SHUTDOWN_TIMEOUT_MS: positiveInt(30_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && (!env.APP_VERSION || env.APP_VERSION === DEVELOPMENT_APP_VERSION)) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_VERSION"],
        message: 'must be set to the released version in production (it is recorded with every model run, and must not be "dev")',
      });
    }
    if (env.STORAGE_DRIVER === "local" && !env.LOCAL_STORAGE_ROOT) {
      ctx.addIssue({
        code: "custom",
        path: ["LOCAL_STORAGE_ROOT"],
        message: 'is required when STORAGE_DRIVER is "local"',
      });
    }
    if (env.STORAGE_DRIVER === "s3") {
      for (const name of ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
        if (!env[name]) {
          ctx.addIssue({ code: "custom", path: [name], message: 'is required when STORAGE_DRIVER is "s3"' });
        }
      }
    }
    if (env.WORKER_HEARTBEAT_INTERVAL_MS * 2 > env.WORKER_LOCK_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["WORKER_HEARTBEAT_INTERVAL_MS"],
        message: "must be at most half of WORKER_LOCK_TIMEOUT_MS",
      });
    }
  })
  .transform((env) => ({
    ...env,
    APP_VERSION: env.APP_VERSION ?? DEVELOPMENT_APP_VERSION,
    GIT_COMMIT_SHA: env.GIT_COMMIT_SHA ?? null,
    WORKER_ID: env.WORKER_ID ?? `worker-${hostname()}`,
    // The mock AI provider is allowed by default everywhere except production.
    AI_ALLOW_MOCK_PROVIDER: env.AI_ALLOW_MOCK_PROVIDER ?? env.NODE_ENV !== "production",
    isProduction: env.NODE_ENV === "production",
  }));

export type WorkerEnv = z.output<typeof envSchema>;

export type WorkerEnvIssue = { variable: string; message: string };

export class WorkerEnvError extends Error {
  readonly issues: WorkerEnvIssue[];

  constructor(issues: WorkerEnvIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);
    super(`Invalid worker environment configuration:\n${lines.join("\n")}\nSee .env.example for every variable.`);
    this.name = "WorkerEnvError";
    this.issues = issues;
  }
}

// An empty string counts as "not set", because .env files list optional
// variables as `NAME=`.
export function parseWorkerEnv(source: Record<string, string | undefined>): WorkerEnv {
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(envSchema.in.shape)) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") cleaned[key] = value.trim();
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    // Only variable names and fixed messages, never the received value.
    const issues = result.error.issues.map((issue) => ({
      variable: issue.path.length > 0 ? String(issue.path[0]) : "(environment)",
      message: issue.message,
    }));
    throw new WorkerEnvError(issues);
  }
  return result.data;
}

// Values that must never appear in a log line or a stored error message.
export function secretValues(env: WorkerEnv): string[] {
  const values: Array<string | undefined> = [env.OPENAI_API_KEY, env.S3_SECRET_ACCESS_KEY, env.S3_ACCESS_KEY_ID];
  try {
    const password = decodeURIComponent(new URL(env.DATABASE_URL).password);
    if (password) values.push(password, new URL(env.DATABASE_URL).password);
  } catch {
    // An unparsable URL fails later when the pool connects.
  }
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length >= 8))];
}
