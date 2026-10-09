import { describe, expect, it } from "vitest";
import { setServiceOverridesForTests, resetProcessServicesForTests } from "@/lib/server/context";
import { resetEnvCacheForTests } from "@/lib/server/env";
import { setupServerTestHarness } from "@/lib/server/test/database";
import { applyTestEnv, TEST_ENV } from "@/lib/server/test/setup";
import { GET as ready } from "./ready/route";
import { GET as health } from "./route";

const harness = setupServerTestHarness();

function assertNoSecrets(text: string): void {
  for (const secret of [TEST_ENV.OPENAI_API_KEY, TEST_ENV.ADMIN_PASSWORD, TEST_ENV.ADMIN_SESSION_SECRET, "postgres:postgres", "5546", "localhost"]) {
    expect(text).not.toContain(secret);
  }
}

describe("GET /api/health", () => {
  it("reports that the process is alive and the app version", async () => {
    const response = health();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "test-version" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("works with an invalid configuration", async () => {
    applyTestEnv({ ADMIN_PASSWORD: undefined, DATABASE_URL: undefined });
    resetEnvCacheForTests();
    expect(health().status).toBe(200);
  });
});

describe("GET /api/health/ready", () => {
  it("returns 200 with a per-check breakdown when everything works", async () => {
    const response = await ready();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      status: "ready",
      version: "test-version",
      checks: { configuration: { ok: true }, database: { ok: true }, storage: { ok: true } },
      warnings: 0,
    });
    assertNoSecrets(text);
  });

  it("counts a configuration warning without saying what it is, and logs the detail", async () => {
    // A public address without a trusted proxy: every client shares one rate limit bucket.
    applyTestEnv({ APP_URL: "https://study.example.org", TRUST_PROXY: "false" });
    resetEnvCacheForTests();
    const response = await ready();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ status: "ready", warnings: 1, checks: { configuration: { ok: true } } });
    expect(text).not.toContain("TRUST_PROXY");
    expect(text).not.toContain("study.example.org");
    const log = harness.logLines.join("");
    expect(log).toContain("TRUST_PROXY_OFF_ON_PUBLIC_URL");
    expect(log).toContain("TRUST_PROXY=true");

    applyTestEnv({ APP_URL: "https://study.example.org", TRUST_PROXY: "true" });
    resetEnvCacheForTests();
    expect((await (await ready()).json()).warnings).toBe(0);
  });

  it("returns 503 when the database URL is wrong", async () => {
    // Use the real pool factory with a URL that points at a closed port.
    setServiceOverridesForTests({ storage: harness.storage });
    applyTestEnv({ DATABASE_URL: "postgresql://someone:db-password-secret@127.0.0.1:1/nothing" });
    resetEnvCacheForTests();
    const response = await ready();
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({
      status: "not_ready",
      checks: { configuration: { ok: true }, database: { ok: false }, storage: { ok: true } },
    });
    expect(text).not.toContain("db-password-secret");
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("ECONNREFUSED");
    await resetProcessServicesForTests();
  });

  it("returns 503 when storage is unhealthy", async () => {
    harness.storage.healthCheck = async () => ({ ok: false, detail: "bucket my-private-bucket is not reachable" });
    const response = await ready();
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(text).checks).toEqual({
      configuration: { ok: true },
      database: { ok: true },
      storage: { ok: false },
    });
    expect(text).not.toContain("my-private-bucket");
    // The detail is in the server log for the operator.
    expect(harness.logLines.join("")).toContain("my-private-bucket");
  });

  it("returns 503 when the storage check throws", async () => {
    harness.storage.healthCheck = async () => {
      throw new Error("EACCES: /srv/private/path");
    };
    const response = await ready();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("/srv/private/path");
  });

  it("returns 503 without naming the invalid variables, and logs their names", async () => {
    applyTestEnv({ ADMIN_SESSION_SECRET: "short", ADMIN_PASSWORD: undefined });
    resetEnvCacheForTests();
    const response = await ready();
    const text = await response.text();
    const body = JSON.parse(text);
    expect(response.status).toBe(503);
    expect(body).toEqual({
      status: "not_ready",
      version: "test-version",
      checks: { configuration: { ok: false }, database: { ok: false }, storage: { ok: false } },
      warnings: 0,
    });
    // The public answer names no variable and holds no value.
    expect(text).not.toMatch(/ADMIN_PASSWORD|ADMIN_SESSION_SECRET|short/);
    // The operator finds the names in the server log, never the values.
    const log = harness.logLines.join("");
    expect(log).toContain("ADMIN_PASSWORD");
    expect(log).toContain("ADMIN_SESSION_SECRET");
    expect(log).not.toContain('"short"');
  });

  it("is ready without an OpenAI key and never contains the key", async () => {
    applyTestEnv({ OPENAI_API_KEY: undefined });
    resetEnvCacheForTests();
    expect((await ready()).status).toBe(200);
  });
});
