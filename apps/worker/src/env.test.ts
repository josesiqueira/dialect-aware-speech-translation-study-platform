import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { parseWorkerEnv, secretValues, WorkerEnvError } from "./env";
import { buildHandlers } from "./handlers";
import { createWorkerLogger } from "./logger";

const base = {
  DATABASE_URL: "postgresql://postgres:a-long-database-password@localhost:5546/dialect_study",
  LOCAL_STORAGE_ROOT: "./data/media",
};

function issuesOf(source: Record<string, string | undefined>) {
  try {
    parseWorkerEnv(source);
  } catch (error) {
    if (error instanceof WorkerEnvError) return error;
    throw error;
  }
  throw new Error("expected a WorkerEnvError");
}

describe("parseWorkerEnv", () => {
  it("applies defaults and treats empty strings as not set", () => {
    const env = parseWorkerEnv({ ...base, OPENAI_API_KEY: "", GIT_COMMIT_SHA: "", WORKER_ID: " " });
    expect(env).toMatchObject({
      NODE_ENV: "development",
      APP_VERSION: "dev",
      GIT_COMMIT_SHA: null,
      STORAGE_DRIVER: "local",
      WORKER_ID: `worker-${hostname()}`,
      WORKER_POLL_INTERVAL_MS: 2000,
      WORKER_CONCURRENCY: 1,
      WORKER_LOCK_TIMEOUT_MS: 600_000,
      WORKER_HEARTBEAT_INTERVAL_MS: 10_000,
      AI_ALLOW_MOCK_PROVIDER: true,
      isProduction: false,
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("reads explicit values", () => {
    const env = parseWorkerEnv({
      ...base,
      WORKER_ID: "worker-7",
      WORKER_POLL_INTERVAL_MS: "500",
      WORKER_CONCURRENCY: "2",
      APP_VERSION: "1.4.0",
      GIT_COMMIT_SHA: "abc1234",
    });
    expect(env).toMatchObject({
      WORKER_ID: "worker-7",
      WORKER_POLL_INTERVAL_MS: 500,
      WORKER_CONCURRENCY: 2,
      APP_VERSION: "1.4.0",
      GIT_COMMIT_SHA: "abc1234",
    });
  });

  it("requires an explicit APP_VERSION in production, so provenance never says dev silently", () => {
    for (const APP_VERSION of [undefined, "", "dev"]) {
      expect(issuesOf({ ...base, NODE_ENV: "production", APP_VERSION }).issues.map((issue) => issue.variable)).toEqual([
        "APP_VERSION",
      ]);
    }
    expect(parseWorkerEnv({ ...base, NODE_ENV: "production", APP_VERSION: "1.4.0" }).APP_VERSION).toBe("1.4.0");
  });

  it("disables the mock provider in production unless set explicitly", () => {
    expect(parseWorkerEnv({ ...base, NODE_ENV: "production", APP_VERSION: "1.4.0" }).AI_ALLOW_MOCK_PROVIDER).toBe(false);
    expect(
      parseWorkerEnv({ ...base, NODE_ENV: "production", APP_VERSION: "1.4.0", AI_ALLOW_MOCK_PROVIDER: "true" }).AI_ALLOW_MOCK_PROVIDER,
    ).toBe(true);
    expect(parseWorkerEnv({ ...base, AI_ALLOW_MOCK_PROVIDER: "false" }).AI_ALLOW_MOCK_PROVIDER).toBe(false);
  });

  it("reports missing and invalid variables by name without their values", () => {
    const error = issuesOf({
      DATABASE_URL: "mysql://user:very-secret-value@host/db",
      WORKER_POLL_INTERVAL_MS: "soon",
      LOCAL_STORAGE_ROOT: "./data/media",
    });
    expect(error.issues.map((issue) => issue.variable)).toEqual(["DATABASE_URL", "WORKER_POLL_INTERVAL_MS"]);
    expect(error.message).not.toContain("very-secret-value");
    expect(error.message).not.toContain("soon");

    // Rules that span several variables are checked once each variable is valid.
    const s3 = issuesOf({ DATABASE_URL: base.DATABASE_URL, STORAGE_DRIVER: "s3", S3_BUCKET: "bucket" });
    expect(s3.issues.map((issue) => issue.variable)).toEqual(["S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);

    expect(issuesOf({}).issues.map((issue) => issue.variable)).toEqual(["DATABASE_URL"]);
    expect(issuesOf({ DATABASE_URL: base.DATABASE_URL }).issues.map((issue) => issue.variable)).toEqual([
      "LOCAL_STORAGE_ROOT",
    ]);
  });

  it("rejects a heartbeat interval above half of the lock timeout", () => {
    const error = issuesOf({ ...base, WORKER_LOCK_TIMEOUT_MS: "10000", WORKER_HEARTBEAT_INTERVAL_MS: "6000" });
    expect(error.issues.map((issue) => issue.variable)).toContain("WORKER_HEARTBEAT_INTERVAL_MS");
  });
});

describe("secret handling", () => {
  it("collects the secret values of the environment", () => {
    const env = parseWorkerEnv({ ...base, OPENAI_API_KEY: "sk-test-not-a-real-key" });
    expect(secretValues(env)).toEqual(
      expect.arrayContaining(["sk-test-not-a-real-key", "a-long-database-password"]),
    );
  });

  it("keeps secrets out of log lines", () => {
    const lines: string[] = [];
    const logger = createWorkerLogger({
      secrets: ["sk-test-not-a-real-key"],
      write: (line) => lines.push(line),
    });
    logger.info(
      { jobId: "j1", apiKey: "another-key-value", nested: { password: "pw-value" } },
      "provider said: invalid key sk-test-not-a-real-key",
    );
    const output = lines.join("");
    expect(output).toContain('"jobId":"j1"');
    expect(output).toContain('"service":"worker"');
    expect(output).not.toContain("sk-test-not-a-real-key");
    expect(output).not.toContain("another-key-value");
    expect(output).not.toContain("pw-value");
  });
});

describe("buildHandlers", () => {
  it("returns a registry of functions keyed by job type", () => {
    const handlers = buildHandlers();
    for (const handler of Object.values(handlers)) expect(typeof handler).toBe("function");
  });
});
