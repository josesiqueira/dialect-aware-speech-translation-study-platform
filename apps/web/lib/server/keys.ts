// Purpose-bound keys derived from ADMIN_SESSION_SECRET.
//
// One secret is configured, but no two uses share a key: each use derives its
// own key with HKDF-SHA-256 (RFC 5869) and a purpose label. A weakness in one
// use (for example the keyed hash of client addresses in rate limit buckets)
// then says nothing about the key that seals the admin session cookie.
//
// Pure functions: no dependency on the validated environment, so proxy.ts can
// use them as well as the route handlers.
import "server-only";
import { hkdfSync } from "node:crypto";

// The labels are part of the derivation. Changing one changes the key: sealed
// cookies and stored bucket keys made with the old label stop matching.
export const KEY_PURPOSES = {
  adminSessionSeal: "dts/admin-session-seal/v1",
  adminPasswordBinding: "dts/admin-password-binding/v1",
  clientAddressHash: "dts/client-address-hash/v1",
} as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[keyof typeof KEY_PURPOSES];

const SALT = Buffer.from("dialect-translation-study", "utf8");

// 32 bytes for the given purpose.
export function deriveKey(secret: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, Buffer.from(purpose, "utf8"), 32));
}

// The same key as 64 hexadecimal characters, for libraries that take a text password.
export function deriveKeyHex(secret: string, purpose: KeyPurpose): string {
  return deriveKey(secret, purpose).toString("hex");
}
