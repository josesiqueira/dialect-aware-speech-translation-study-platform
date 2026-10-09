// Sealing and unsealing of the admin session cookie value (spec 39).
// Pure functions with no dependency on the request, the database or the validated
// environment, so that proxy.ts can use them as well as the route handlers.
//
// The cookie value is an iron-session seal: encrypted (AES-256-CBC) and signed
// (HMAC-SHA-256) with a key derived from ADMIN_SESSION_SECRET for this purpose
// (see ./keys). A changed or forged value fails to unseal.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sealData, unsealData } from "iron-session";
import { deriveKey, deriveKeyHex, KEY_PURPOSES } from "./keys";

// Name of the cookie over plain http (development, and a production build that
// is tested on http://localhost).
export const ADMIN_COOKIE_NAME = "dts_admin";
// Name of the cookie when the app is served over https in production. A browser
// accepts a `__Host-` cookie only with `Secure`, `Path=/` and no `Domain`
// attribute, from a secure origin. So the cookie cannot be set or replaced by
// another subdomain or over plain http (RFC 6265bis, cookie name prefixes).
export const ADMIN_COOKIE_NAME_HOST_PREFIXED = `__Host-${ADMIN_COOKIE_NAME}`;

// The cookie name of this deployment. Decided from NODE_ENV and APP_URL only, so
// proxy.ts (which reads process.env) and the route handlers agree.
export function adminCookieName(
  env: { NODE_ENV?: string | undefined; APP_URL?: string | undefined } = process.env,
): string {
  const https = (env.APP_URL ?? "").trim().toLowerCase().startsWith("https://");
  return env.NODE_ENV === "production" && https ? ADMIN_COOKIE_NAME_HOST_PREFIXED : ADMIN_COOKIE_NAME;
}

export type AdminSession = {
  role: "admin";
  // ISO 8601 timestamps.
  issuedAt: string;
  expiresAt: string;
  actorLabel: string;
};

// What is sealed into the cookie: the session and a tag of the admin password
// that was current when the cookie was issued.
type SealedAdminSession = AdminSession & { passwordTag?: string };

// A short keyed hash of ADMIN_PASSWORD (HMAC-SHA-256 with a key derived from
// ADMIN_SESSION_SECRET, cut to 16 hexadecimal characters). It is sealed into the
// cookie. A cookie whose tag differs from the tag of the current password is
// rejected, so changing the password ends every session. The tag is inside the
// encrypted seal and never visible to the browser. 64 bits are enough here: the
// tag is not a password verifier anyone can query, only an equality check
// inside a value that is already authenticated.
export function adminPasswordTag(password: string, secret: string): string {
  return createHmac("sha256", deriveKey(secret, KEY_PURPOSES.adminPasswordBinding))
    .update(password, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function sealKey(secret: string): string {
  return deriveKeyHex(secret, KEY_PURPOSES.adminSessionSeal);
}

// `passwordTag`: adminPasswordTag() of the current password. Route handlers
// always pass it. Without it the cookie is not bound to the password.
export async function sealAdminSession(session: AdminSession, secret: string, passwordTag?: string): Promise<string> {
  const ttlSeconds = Math.max(
    1,
    Math.ceil((new Date(session.expiresAt).getTime() - new Date(session.issuedAt).getTime()) / 1000),
  );
  const payload: SealedAdminSession = { ...session, ...(passwordTag ? { passwordTag } : {}) };
  return sealData(payload, { password: sealKey(secret), ttl: ttlSeconds });
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

// Returns the session, or null when the value is missing, forged, sealed with another
// secret, malformed or expired. Expiry is enforced here from the sealed `expiresAt`,
// independent of the cookie max-age that the browser applies.
//
// `expectedPasswordTag`: when given, a cookie that carries another tag, or no
// tag, is rejected (the admin password changed after the cookie was issued).
export async function unsealAdminSession(
  sealed: string | undefined | null,
  secret: string | undefined | null,
  now: Date = new Date(),
  expectedPasswordTag?: string,
): Promise<AdminSession | null> {
  if (!sealed || !secret || secret.length < 32) return null;
  let data: unknown;
  try {
    data = await unsealData<unknown>(sealed, { password: sealKey(secret) });
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Partial<SealedAdminSession>;
  if (candidate.role !== "admin") return null;
  if (typeof candidate.issuedAt !== "string" || typeof candidate.expiresAt !== "string") return null;
  if (typeof candidate.actorLabel !== "string" || candidate.actorLabel === "") return null;
  const expiresAt = new Date(candidate.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return null;
  if (expectedPasswordTag !== undefined) {
    if (typeof candidate.passwordTag !== "string" || !sameText(candidate.passwordTag, expectedPasswordTag)) return null;
  }
  return {
    role: "admin",
    issuedAt: candidate.issuedAt,
    expiresAt: candidate.expiresAt,
    actorLabel: candidate.actorLabel,
  };
}

// Only local admin paths, and the Demo Mode page "/demo" (with a query string),
// are accepted as a redirect target after login, so the `next` query parameter
// cannot send the admin to another site. "/demo" is in the list because Demo
// Mode can require an admin session and sends the visitor to the login page.
export function safeAdminNextPath(value: string | null | undefined): string {
  if (!value) return "/admin";
  if (value.startsWith("//") || value.includes("\\")) return "/admin";
  if (value === "/demo" || value.startsWith("/demo?")) return value;
  if (!value.startsWith("/admin")) return "/admin";
  if (value === "/admin/login" || value.startsWith("/admin/login?") || value.startsWith("/admin/login/")) {
    return "/admin";
  }
  // "/administrator" is not an admin path.
  const rest = value.slice("/admin".length);
  if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("?")) return "/admin";
  return value;
}
