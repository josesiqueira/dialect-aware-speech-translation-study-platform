import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rateLimitHits } from "@dialect/db";
import { resetEnvCacheForTests } from "./env";
import {
  checkRateLimit,
  clientAddress,
  clientAddressKey,
  consumeRateLimit,
  purgeOldHits,
  recordHit,
  removeHit,
} from "./rate-limit";
import { setupServerTestHarness } from "./test/database";
import { applyTestEnv } from "./test/setup";

const harness = setupServerTestHarness();
const T0 = new Date("2026-10-03T09:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("checkRateLimit and recordHit", () => {
  it("allows up to the limit, then reports when to retry, then recovers after the window", async () => {
    const db = harness.database.db;
    const options = { bucket: "test:window", limit: 3, windowSeconds: 60 };

    expect(await checkRateLimit(db, { ...options, now: T0 })).toEqual({ allowed: true, remaining: 3, retryAfterSeconds: 0 });
    await recordHit(db, options.bucket, at(0));
    await recordHit(db, options.bucket, at(10));
    expect(await checkRateLimit(db, { ...options, now: at(11) })).toMatchObject({ allowed: true, remaining: 1 });
    await recordHit(db, options.bucket, at(20));

    // Full: the oldest hit (t=0) leaves the window at t=60.
    expect(await checkRateLimit(db, { ...options, now: at(30) })).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 30 });
    expect(await checkRateLimit(db, { ...options, now: at(59) })).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    // Recovered: one slot is free again.
    expect(await checkRateLimit(db, { ...options, now: at(61) })).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    expect(await checkRateLimit(db, { ...options, now: at(200) })).toMatchObject({ allowed: true, remaining: 3 });
  });

  it("keeps buckets separate", async () => {
    const db = harness.database.db;
    await recordHit(db, "test:a", T0);
    expect(await checkRateLimit(db, { bucket: "test:a", limit: 1, windowSeconds: 60, now: T0 })).toMatchObject({ allowed: false });
    expect(await checkRateLimit(db, { bucket: "test:b", limit: 1, windowSeconds: 60, now: T0 })).toMatchObject({ allowed: true });
  });
});

describe("consumeRateLimit", () => {
  it("never lets concurrent callers exceed the limit", async () => {
    const db = harness.database.db;
    const options = { bucket: "test:concurrent", limit: 5, windowSeconds: 60, now: T0 };
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeRateLimit(db, options)));
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed).every((result) => result.hitId === null)).toBe(true);
    const rows = await db.select().from(rateLimitHits).where(eq(rateLimitHits.bucketKey, options.bucket));
    expect(rows).toHaveLength(5);
  });

  it("gives a slot back with removeHit", async () => {
    const db = harness.database.db;
    const options = { bucket: "test:refund", limit: 1, windowSeconds: 60, now: T0 };
    const first = await consumeRateLimit(db, options);
    expect(first).toMatchObject({ allowed: true, remaining: 0 });
    expect(await consumeRateLimit(db, options)).toMatchObject({ allowed: false });
    await removeHit(db, first.hitId as string);
    expect(await consumeRateLimit(db, options)).toMatchObject({ allowed: true });
  });
});

describe("purgeOldHits", () => {
  it("deletes only rows older than the maximum age", async () => {
    const db = harness.database.db;
    await recordHit(db, "test:purge", at(-90_000));
    await recordHit(db, "test:purge", at(-100));
    await purgeOldHits(db, { now: T0 });
    const rows = await db.select().from(rateLimitHits).where(eq(rateLimitHits.bucketKey, "test:purge"));
    expect(rows).toHaveLength(1);
  });
});

describe("clientAddressKey", () => {
  const request = (forwarded?: string) =>
    new Request("http://localhost:3000/api/admin/login", {
      headers: forwarded ? { "x-forwarded-for": forwarded } : {},
    });

  it("ignores x-forwarded-for unless TRUST_PROXY is on", () => {
    expect(clientAddress(request("203.0.113.9"))).toBe("unknown");
    expect(clientAddressKey(request("203.0.113.9"))).toBe(clientAddressKey(request("198.51.100.7")));
  });

  it("uses the entry written by the nearest proxy and never returns the raw address", () => {
    applyTestEnv({ TRUST_PROXY: "true" });
    resetEnvCacheForTests();
    // The first entry can be forged by the client. The last one is added by the proxy.
    expect(clientAddress(request("1.2.3.4, 203.0.113.9"))).toBe("203.0.113.9");
    const key = clientAddressKey(request("203.0.113.9"));
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain("203.0.113.9");
    expect(clientAddressKey(request("9.9.9.9, 203.0.113.9"))).toBe(key);
    expect(clientAddressKey(request("198.51.100.7"))).not.toBe(key);
  });

  it("depends on the secret, so the hash cannot be recomputed without it", () => {
    applyTestEnv({ TRUST_PROXY: "true" });
    resetEnvCacheForTests();
    const first = clientAddressKey(request("203.0.113.9"));
    applyTestEnv({ TRUST_PROXY: "true", ADMIN_SESSION_SECRET: "another-secret-another-secret-another-secret" });
    resetEnvCacheForTests();
    expect(clientAddressKey(request("203.0.113.9"))).not.toBe(first);
  });
});
