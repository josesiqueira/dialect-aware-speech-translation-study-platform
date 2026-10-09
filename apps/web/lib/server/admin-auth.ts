// Admin authentication (spec 39): one researcher access boundary, no user accounts.
//
// Usage:
//   Route handlers: use apiRoute(handler, { auth: "admin" }) from ./api. It calls requireAdmin().
//   Server components and layouts under /admin:  const session = await requireAdminPage();
//
// The session lives in a sealed, signed, HttpOnly cookie (see ./admin-session).
// Three things end a session before its sealed expiry time:
// - Sign out. The sign-out writes the audit row `admin.logout` with the time
//   `sessionsValidAfter`, and every cookie issued before that time is rejected.
//   There is one shared admin password and no user accounts, so a sign-out ends
//   every admin session, on every device.
// - A change of ADMIN_PASSWORD. The cookie carries a keyed hash of the password
//   it was issued under and is rejected when the password is another one.
// - A change of ADMIN_SESSION_SECRET (the seal no longer opens).
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminAuditLog } from "@dialect/db";
import { AppError } from "@dialect/domain";
import { recordAudit, type ServiceContext } from "@dialect/research";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_COOKIE_NAME_HOST_PREFIXED,
  adminCookieName,
  adminPasswordTag,
  safeAdminNextPath,
  sealAdminSession,
  unsealAdminSession,
  type AdminSession,
} from "./admin-session";
import { currentTime, getDb } from "./context";
import { getEnv } from "./env";
import { clientAddressKey, consumeRateLimit, hasClientAddress, purgeOldHits } from "./rate-limit";

export { ADMIN_COOKIE_NAME, adminCookieName, safeAdminNextPath, type AdminSession };

// Request header written by proxy.ts with the requested path, read by requireAdminPage().
export const PATHNAME_HEADER = "x-dts-pathname";

// Throttle of FAILED logins (spec 39, 67). See loginAdmin() for the rules and
// docs/PRIVACY-IMPLEMENTATION-NOTES.md for what the throttle does and does not do.
//
// Global: at most this many failed attempts per minute are answered with 401
// and written to the audit log (1800 per hour). Further failures get 429.
export const LOGIN_FAILURE_WINDOW_SECONDS = 60;
export const LOGIN_FAILURES_PER_WINDOW = 30;
// Per client address, only when TRUST_PROXY gives a real address.
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_FAILURES_PER_ADDRESS = 5;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// Constant-time comparison. Both sides are hashed first, so the comparison always
// runs over 32 bytes and the length of the real password does not leak.
export function verifyAdminPassword(candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  return timingSafeEqual(sha256(candidate), sha256(getEnv().ADMIN_PASSWORD));
}

function currentPasswordTag(): string {
  const env = getEnv();
  return adminPasswordTag(env.ADMIN_PASSWORD, env.ADMIN_SESSION_SECRET);
}

function cookieAttributes(maxAge: number) {
  // These attributes also satisfy the `__Host-` prefix: Secure, Path=/, no Domain.
  return { httpOnly: true, sameSite: "strict" as const, secure: getEnv().isProduction, path: "/", maxAge };
}

// Issues the session cookie. Call it from a route handler or server action only
// (cookies cannot be set while a server component renders).
export async function createAdminSession(actorLabel: string = "admin"): Promise<AdminSession> {
  const env = getEnv();
  const now = currentTime();
  const ttlSeconds = Math.round(env.ADMIN_SESSION_TTL_HOURS * 3600);
  const session: AdminSession = {
    role: "admin",
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    actorLabel,
  };
  const sealed = await sealAdminSession(session, env.ADMIN_SESSION_SECRET, currentPasswordTag());
  const cookieStore = await cookies();
  cookieStore.set(adminCookieName(), sealed, cookieAttributes(ttlSeconds));
  return session;
}

export async function destroyAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  // Overwrite with an expired cookie that has the same attributes, so every browser removes it.
  const name = adminCookieName();
  cookieStore.set(name, "", cookieAttributes(0));
  // A cookie with the plain name can be left from before the deployment moved to https.
  if (name === ADMIN_COOKIE_NAME_HOST_PREFIXED) cookieStore.set(ADMIN_COOKIE_NAME, "", cookieAttributes(0));
}

// ---------------------------------------------------------------------------
// "Sessions valid after": the server-side end of sessions at sign-out
// ---------------------------------------------------------------------------

// Where the time is kept: in the newest `admin.logout` row of admin_audit_log
// (after_json.sessionsValidAfter). Reasons for this place:
// - the audit log is append-only in the database (no update, no delete, not even
//   by the test data reset), so a revocation cannot be undone or lost;
// - no schema change and no key in studies.settings_json, which the Settings
//   page rewrites;
// - the revocation is its own audit record.
// The value is cached in this process for a few seconds, so a request does not
// read the database every time. Another web replica therefore accepts a signed-out
// cookie for at most SESSIONS_VALID_AFTER_CACHE_MS after the sign-out.
export const SESSIONS_VALID_AFTER_CACHE_MS = 5000;

let validAfterCache: { value: Date | null; readAt: number } | null = null;

export function resetAdminSessionCacheForTests(): void {
  validAfterCache = null;
}

async function readSessionsValidAfter(): Promise<Date | null> {
  const [row] = await getDb()
    .select({ after: adminAuditLog.afterJson })
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "admin_session"), eq(adminAuditLog.action, "admin.logout")))
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(1);
  const value = (row?.after as { sessionsValidAfter?: unknown } | null | undefined)?.sessionsValidAfter;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function sessionsValidAfter(): Promise<Date | null> {
  const cached = validAfterCache;
  if (cached && Date.now() - cached.readAt < SESSIONS_VALID_AFTER_CACHE_MS) return cached.value;
  const value = await readSessionsValidAfter();
  validAfterCache = { value, readAt: Date.now() };
  return value;
}

// The verified session of the current request, or null. Rejected: a missing,
// forged or expired cookie, a cookie issued under another admin password, and a
// cookie issued before the last sign-out.
export async function getAdminSession(): Promise<AdminSession | null> {
  const cookieStore = await cookies();
  const sealed = cookieStore.get(adminCookieName())?.value;
  if (!sealed) return null;
  const session = await unsealAdminSession(sealed, getEnv().ADMIN_SESSION_SECRET, currentTime(), currentPasswordTag());
  if (!session) return null;
  const validAfter = await sessionsValidAfter();
  if (validAfter && new Date(session.issuedAt).getTime() < validAfter.getTime()) return null;
  return session;
}

// What the login page needs to know (defect E2E-3). `session` is the result of
// the full check. `rejectedCookie` is true when the browser sent a session
// cookie that the full check refuses, for example one issued before a sign-out
// in another browser. proxy.ts cannot see that case, because it has no database.
export async function getAdminLoginState(): Promise<{ session: AdminSession | null; rejectedCookie: boolean }> {
  const cookieStore = await cookies();
  const present = Boolean(cookieStore.get(adminCookieName())?.value);
  const session = await getAdminSession();
  return { session, rejectedCookie: present && session === null };
}

// Removes a session cookie that the full check refuses, and nothing else: a
// valid session is left alone and no sign-out is recorded. Cookies cannot be
// changed while a server component renders (Next.js: only in a Server Function
// or a Route Handler), so requireAdminPage() cannot remove the cookie itself.
// The login page asks for it through POST /api/admin/logout?rejected-cookie-only=1.
// Returns true when a cookie was removed.
export async function clearRejectedAdminCookie(): Promise<boolean> {
  const { rejectedCookie } = await getAdminLoginState();
  if (rejectedCookie) await destroyAdminSession();
  return rejectedCookie;
}

// For route handlers. Throws AppError("UNAUTHORIZED") without a valid session.
export async function requireAdmin(): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) throw new AppError("UNAUTHORIZED", "Admin sign-in is required.");
  return session;
}

// For server components and layouts. Redirects to the login page without a valid session.
// `nextPath` is where to return after login; by default the path that proxy.ts recorded.
// The login page never redirects back on a weaker check than this one (it calls
// getAdminLoginState()), so a refused cookie cannot cause a redirect loop.
export async function requireAdminPage(nextPath?: string): Promise<AdminSession> {
  const session = await getAdminSession();
  if (session) return session;
  const requested = nextPath ?? (await headers()).get(PATHNAME_HEADER);
  redirect(`/admin/login?next=${encodeURIComponent(safeAdminNextPath(requested))}`);
}

// Full login step used by POST /api/admin/login: verify, set cookie, audit, and
// throttle failures. Throws AppError("UNAUTHORIZED") or AppError("RATE_LIMITED").
//
// Rules:
// 1. The password is checked first. A correct password always signs in. No
//    counter can refuse it, so nobody can lock the researcher out by sending
//    wrong passwords (the earlier hard limit allowed exactly that).
// 2. A wrong password is counted. Within the rate it is answered 401 and
//    written to the audit log. Beyond the rate it is answered 429 and is not
//    written, so a flood of guesses cannot fill the audit log or the
//    rate_limit_hits table.
// 3. With TRUST_PROXY=true the failures of one client address are also limited
//    (5 in 15 minutes). Without a real address there is no per-address limit:
//    it would be one limit shared by everyone.
//
// What this does not do: it does not cap how many passwords an attacker can
// test. A 429 tells the sender that the guess was wrong, like a 401. Protection
// against guessing comes from the password itself (at least 12 characters in
// production, generated randomly) and from a request limit at the reverse proxy.
export async function loginAdmin(
  ctx: ServiceContext,
  request: Request,
  password: unknown,
): Promise<AdminSession> {
  if (verifyAdminPassword(password)) {
    const session = await createAdminSession("admin");
    await recordAudit(ctx.db, {
      action: "admin.login",
      entityType: "admin_session",
      after: { expiresAt: session.expiresAt },
      actorLabel: session.actorLabel,
    });
    return session;
  }

  const now = ctx.now();
  await purgeOldHits(ctx.db, { now }).catch(() => {});
  const refuse = (scope: "address" | "global", retryAfterSeconds: number): AppError => {
    ctx.logger.warn({ event: "admin.login_rate_limited", scope }, "failed admin logins exceed the rate");
    return new AppError(
      "RATE_LIMITED",
      "The password is not correct. Too many failed sign-in attempts are being made, so this one was not recorded.",
      { retryAfterSeconds },
    );
  };

  if (hasClientAddress(request)) {
    const perAddress = await consumeRateLimit(ctx.db, {
      bucket: `login:addr:${clientAddressKey(request)}`,
      limit: LOGIN_FAILURES_PER_ADDRESS,
      windowSeconds: LOGIN_WINDOW_SECONDS,
      now,
    });
    if (!perAddress.allowed) throw refuse("address", perAddress.retryAfterSeconds);
  }
  const global = await consumeRateLimit(ctx.db, {
    bucket: "login:failed",
    limit: LOGIN_FAILURES_PER_WINDOW,
    windowSeconds: LOGIN_FAILURE_WINDOW_SECONDS,
    now,
  });
  if (!global.allowed) throw refuse("global", global.retryAfterSeconds);

  // The audit row holds no password content and no client address.
  await recordAudit(ctx.db, {
    action: "admin.login_failed",
    entityType: "admin_session",
    after: { reason: "wrong_password" },
    actorLabel: null,
  });
  throw new AppError("UNAUTHORIZED", "The password is not correct.");
}

// Used by POST /api/admin/logout. Safe to call without a session. Only a request
// with a valid session ends the sessions: an anonymous request cannot sign the
// researcher out.
export async function logoutAdmin(ctx: ServiceContext): Promise<void> {
  const session = await getAdminSession();
  await destroyAdminSession();
  if (session) {
    const validAfter = currentTime();
    await recordAudit(ctx.db, {
      action: "admin.logout",
      entityType: "admin_session",
      // Every admin cookie issued before this time is rejected from now on.
      after: { sessionsValidAfter: validAfter.toISOString() },
      actorLabel: session.actorLabel,
    });
    validAfterCache = { value: validAfter, readAt: Date.now() };
  }
}
