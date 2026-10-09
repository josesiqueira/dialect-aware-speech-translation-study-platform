// Rate limiting backed by the rate_limit_hits table, so the limit holds across
// several web replicas (spec 39, 67).
//
// Usage (count every attempt, allow at most 5 per 15 minutes per client):
//   const key = clientAddressKey(request);
//   const result = await consumeRateLimit(db, { bucket: `session-create:${key}`, limit: 5, windowSeconds: 900 });
//   if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
//
// Privacy: a bucket key never contains a raw IP address. clientAddressKey() returns
// an HMAC-SHA-256 of the address. The HMAC key is derived from ADMIN_SESSION_SECRET
// for this purpose only (HKDF, see ./keys), so it is not the key that seals the
// admin cookie. Rows older than one day are deleted by purgeOldHits(), which
// callers run opportunistically.
import "server-only";
import { createHmac } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { rateLimitHits, type DbOrTx } from "@dialect/db";
import { AppError } from "@dialect/domain";
import { getEnv } from "./env";
import { deriveKey, KEY_PURPOSES } from "./keys";

export type RateLimitOptions = {
  // Bucket name, for example `login:addr:<clientAddressKey>` or `login:global`.
  bucket: string;
  // Maximum number of hits inside the window.
  limit: number;
  windowSeconds: number;
  // Injectable clock for tests. Defaults to the current time.
  now?: Date;
};

export type RateLimitResult = {
  allowed: boolean;
  // Hits still available in the current window (after this one, for consumeRateLimit).
  remaining: number;
  // Seconds until the oldest hit leaves the window. 0 when allowed.
  retryAfterSeconds: number;
};

// Read-only check: reports whether one more hit fits in the window. It records nothing.
// Two concurrent callers can both see "allowed"; use consumeRateLimit() when the
// check and the hit must be one atomic step.
export async function checkRateLimit(db: DbOrTx, options: RateLimitOptions): Promise<RateLimitResult> {
  const now = options.now ?? new Date();
  const windowStart = new Date(now.getTime() - options.windowSeconds * 1000);
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | string | null>`min(${rateLimitHits.createdAt})`,
    })
    .from(rateLimitHits)
    .where(and(eq(rateLimitHits.bucketKey, options.bucket), gt(rateLimitHits.createdAt, windowStart)));

  const count = row?.count ?? 0;
  if (count < options.limit) {
    return { allowed: true, remaining: options.limit - count, retryAfterSeconds: 0 };
  }
  const oldest = row?.oldest ? new Date(row.oldest) : now;
  const freeAt = oldest.getTime() + options.windowSeconds * 1000;
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil((freeAt - now.getTime()) / 1000)),
  };
}

// Records one hit and returns its id (pass the id to removeHit() to give it back).
export async function recordHit(db: DbOrTx, bucket: string, now: Date = new Date()): Promise<string> {
  const [row] = await db
    .insert(rateLimitHits)
    .values({ bucketKey: bucket, createdAt: now })
    .returning({ id: rateLimitHits.id });
  return row.id;
}

// Atomic check and hit: counts and inserts in one transaction, serialized per bucket
// with a transaction-scoped advisory lock. Safe with concurrent requests and with
// several replicas. When the limit is reached nothing is recorded.
export async function consumeRateLimit(
  db: DbOrTx,
  options: RateLimitOptions,
): Promise<RateLimitResult & { hitId: string | null }> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${options.bucket}, 0))`);
    const result = await checkRateLimit(tx, { ...options, now });
    if (!result.allowed) return { ...result, hitId: null };
    const hitId = await recordHit(tx, options.bucket, now);
    return { allowed: true, remaining: result.remaining - 1, retryAfterSeconds: 0, hitId };
  });
}

// Gives a recorded hit back, for example after a login attempt turned out to be correct.
export async function removeHit(db: DbOrTx, hitId: string): Promise<void> {
  await db.delete(rateLimitHits).where(eq(rateLimitHits.id, hitId));
}

// Deletes hits older than maxAgeSeconds (default one day, longer than any window in use).
export async function purgeOldHits(
  db: DbOrTx,
  options: { maxAgeSeconds?: number; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.maxAgeSeconds ?? 86_400) * 1000);
  await db.delete(rateLimitHits).where(lt(rateLimitHits.createdAt, cutoff));
}

export function rateLimitedError(retryAfterSeconds: number): AppError {
  return new AppError("RATE_LIMITED", "Too many attempts. Please wait and try again.", {
    retryAfterSeconds,
  });
}

// The client address as the server can know it.
// TRUST_PROXY=false: a route handler has no access to the socket address, so every
// client shares the key for "unknown". Per-address limits then act as one shared limit.
// TRUST_PROXY=true: the last entry of x-forwarded-for is used. That entry is written
// by the reverse proxy closest to the app, so a client cannot forge it. This assumes
// exactly one trusted reverse proxy in front of the app.
export function clientAddress(request: Request): string {
  if (!getEnv().TRUST_PROXY) return "unknown";
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  const entries = forwarded
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return entries[entries.length - 1] ?? "unknown";
}

// True when the server knows a real client address: TRUST_PROXY is on and the
// reverse proxy sent x-forwarded-for. Otherwise every client looks the same and a
// per-address limit would be one shared limit.
export function hasClientAddress(request: Request): boolean {
  return clientAddress(request) !== "unknown";
}

// Keyed hash of the client address, safe to store as part of a bucket key.
export function clientAddressKey(request: Request): string {
  return createHmac("sha256", deriveKey(getEnv().ADMIN_SESSION_SECRET, KEY_PURPOSES.clientAddressHash))
    .update(`client-address:${clientAddress(request)}`)
    .digest("hex")
    .slice(0, 32);
}
