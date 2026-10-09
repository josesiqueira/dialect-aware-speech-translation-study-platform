import { describe, expect, it } from "vitest";
import {
  configurationWarnings,
  EnvValidationError,
  getEnv,
  isLocalAddress,
  parseEnv,
  resetEnvCacheForTests,
} from "./env";
import { deriveKey, KEY_PURPOSES } from "./keys";
import { applyTestEnv, TEST_ENV } from "./test/setup";

const base = { ...TEST_ENV };

function failure(source: Record<string, string | undefined>): EnvValidationError {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error("expected parseEnv to throw");
}

describe("parseEnv", () => {
  it("applies the defaults from the specification", () => {
    const env = parseEnv({
      DATABASE_URL: base.DATABASE_URL,
      ADMIN_PASSWORD: "short-ok",
      ADMIN_SESSION_SECRET: base.ADMIN_SESSION_SECRET,
    });
    expect(env).toMatchObject({
      NODE_ENV: "development",
      APP_URL: "http://localhost:3000",
      APP_VERSION: "dev",
      GIT_COMMIT_SHA: null,
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_ROOT: "./data/media",
      S3_FORCE_PATH_STYLE: false,
      MAX_AUDIO_UPLOAD_MB: 100,
      MAX_UTTERANCE_SECONDS: 300,
      WORKER_ID: "worker-1",
      WORKER_POLL_INTERVAL_MS: 2000,
      ADMIN_SESSION_TTL_HOURS: 8,
      PARTICIPANT_SESSION_TTL_HOURS: 24,
      TRUST_PROXY: false,
      AI_ALLOW_MOCK_PROVIDER: true,
      isProduction: false,
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("treats empty strings as not set", () => {
    const env = parseEnv({ ...base, OPENAI_API_KEY: "", GIT_COMMIT_SHA: "", S3_ENDPOINT: "  " });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GIT_COMMIT_SHA).toBeNull();
    expect(env.S3_ENDPOINT).toBeUndefined();
  });

  it("works without OPENAI_API_KEY", () => {
    expect(() => parseEnv({ ...base, OPENAI_API_KEY: undefined })).not.toThrow();
  });

  it("lists every missing required variable by name", () => {
    const error = failure({});
    const names = error.issues.map((issue) => issue.variable);
    expect(names).toEqual(expect.arrayContaining(["DATABASE_URL", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"]));
    expect(error.message).toContain("DATABASE_URL: is required");
    expect(error.message).toContain("ADMIN_PASSWORD: is required");
  });

  it("rejects a session secret shorter than 32 characters without printing it", () => {
    const error = failure({ ...base, ADMIN_SESSION_SECRET: "too-short-secret" });
    expect(error.issues).toEqual([
      expect.objectContaining({ variable: "ADMIN_SESSION_SECRET", message: expect.stringContaining("32") }),
    ]);
    expect(error.message).not.toContain("too-short-secret");
  });

  it("requires 12 characters for the admin password in production only", () => {
    expect(() => parseEnv({ ...base, ADMIN_PASSWORD: "short" })).not.toThrow();
    const error = failure({ ...base, NODE_ENV: "production", ADMIN_PASSWORD: "short" });
    expect(error.issues[0]).toMatchObject({ variable: "ADMIN_PASSWORD" });
    expect(error.message).toContain("at least 12 characters in production");
  });

  it("turns the mock AI provider off by default in production", () => {
    expect(parseEnv({ ...base, NODE_ENV: "production" }).AI_ALLOW_MOCK_PROVIDER).toBe(false);
    expect(parseEnv({ ...base, NODE_ENV: "production", AI_ALLOW_MOCK_PROVIDER: "true" }).AI_ALLOW_MOCK_PROVIDER).toBe(true);
    expect(parseEnv({ ...base, AI_ALLOW_MOCK_PROVIDER: "false" }).AI_ALLOW_MOCK_PROVIDER).toBe(false);
  });

  it("rejects invalid values and never echoes them", () => {
    const error = failure({
      ...base,
      DATABASE_URL: "mysql://user:hunter2secret@host/db",
      TRUST_PROXY: "maybe",
      MAX_AUDIO_UPLOAD_MB: "-5",
      ADMIN_SESSION_TTL_HOURS: "abc",
      STORAGE_DRIVER: "ftp",
    });
    const names = error.issues.map((issue) => issue.variable);
    expect(names).toEqual(
      expect.arrayContaining(["DATABASE_URL", "TRUST_PROXY", "MAX_AUDIO_UPLOAD_MB", "ADMIN_SESSION_TTL_HOURS", "STORAGE_DRIVER"]),
    );
    expect(error.message).not.toContain("hunter2secret");
    expect(error.message).not.toContain("maybe");
  });

  it("requires the S3 settings when the driver is s3", () => {
    const error = failure({ ...base, STORAGE_DRIVER: "s3" });
    expect(error.issues.map((issue) => issue.variable)).toEqual(
      expect.arrayContaining(["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]),
    );
  });

  it("parses numbers and booleans", () => {
    const env = parseEnv({ ...base, TRUST_PROXY: "true", ADMIN_SESSION_TTL_HOURS: "0.5", MAX_AUDIO_UPLOAD_MB: "25" });
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.ADMIN_SESSION_TTL_HOURS).toBe(0.5);
    expect(env.MAX_AUDIO_UPLOAD_MB).toBe(25);
  });
});

describe("APP_VERSION", () => {
  it("defaults to dev outside production", () => {
    expect(parseEnv({ ...TEST_ENV, APP_VERSION: undefined }).APP_VERSION).toBe("dev");
  });

  it("must be set to a real version in production, so provenance never says dev silently", () => {
    const production = { ...TEST_ENV, NODE_ENV: "production" };
    for (const APP_VERSION of [undefined, "", "dev"]) {
      expect(failure({ ...production, APP_VERSION }).issues.map((issue) => issue.variable)).toEqual(["APP_VERSION"]);
    }
    expect(parseEnv({ ...production, APP_VERSION: "1.4.0" }).APP_VERSION).toBe("1.4.0");
  });
});

describe("configurationWarnings", () => {
  const warningCodes = (changes: Record<string, string>) =>
    configurationWarnings(parseEnv({ ...TEST_ENV, ...changes })).map((warning) => warning.code);

  it("warns when a public address runs without a trusted proxy", () => {
    expect(warningCodes({ APP_URL: "https://study.example.org", TRUST_PROXY: "false" })).toEqual(["TRUST_PROXY_OFF_ON_PUBLIC_URL"]);
    expect(warningCodes({ APP_URL: "http://192.168.1.20:3000" })).toEqual(["TRUST_PROXY_OFF_ON_PUBLIC_URL"]);
  });

  it("does not warn on a local address or with a trusted proxy", () => {
    for (const APP_URL of ["http://localhost:3000", "http://127.0.0.1:3100", "http://[::1]:3000", "http://study.localhost"]) {
      expect(warningCodes({ APP_URL }), APP_URL).toEqual([]);
      expect(isLocalAddress(APP_URL)).toBe(true);
    }
    expect(warningCodes({ APP_URL: "https://study.example.org", TRUST_PROXY: "true" })).toEqual([]);
    expect(isLocalAddress("https://localhost.example.org")).toBe(false);
  });
});

describe("purpose-bound keys", () => {
  it("derives a different key for every purpose, and the same key every time", () => {
    const secret = TEST_ENV.ADMIN_SESSION_SECRET;
    const keys = Object.values(KEY_PURPOSES).map((purpose) => deriveKey(secret, purpose).toString("hex"));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.length === 64)).toBe(true);
    expect(deriveKey(secret, KEY_PURPOSES.clientAddressHash).toString("hex")).toBe(keys[2]);
    expect(deriveKey(`${secret}x`, KEY_PURPOSES.clientAddressHash).toString("hex")).not.toBe(keys[2]);
    // No derived key is the secret itself.
    expect(keys).not.toContain(Buffer.from(secret).toString("hex"));
  });
});

describe("getEnv", () => {
  it("parses once and caches until reset", () => {
    const first = getEnv();
    applyTestEnv({ APP_VERSION: "changed" });
    expect(getEnv()).toBe(first);
    resetEnvCacheForTests();
    expect(getEnv().APP_VERSION).toBe("changed");
  });

  it("throws a readable error for an invalid process environment", () => {
    applyTestEnv({ ADMIN_PASSWORD: undefined });
    resetEnvCacheForTests();
    expect(() => getEnv()).toThrow(/Invalid environment configuration:\n {2}- ADMIN_PASSWORD: is required/);
  });
});
