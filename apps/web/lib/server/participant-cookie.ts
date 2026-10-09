// Participant session cookie helpers (spec 61, 138).
//
// The cookie holds an opaque random token. The database stores only its SHA-256
// (sessions.token_hash), so a database leak does not reveal usable tokens.
//
// Usage (in the session service's route handlers):
//   const token = generateParticipantToken();
//   // store hashParticipantToken(token) and the expiry in sessions, then:
//   await setParticipantCookie(token, expiresAt);
//   // later requests:
//   const token = await readParticipantToken();
//   // look the session up by hashParticipantToken(token); on completion or withdrawal:
//   await clearParticipantCookie();
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { currentTime } from "./context";
import { getEnv } from "./env";

export const PARTICIPANT_COOKIE_NAME = "dts_participant";

// 32 random bytes, base64url encoded (43 characters).
export function generateParticipantToken(): string {
  return randomBytes(32).toString("base64url");
}

// Hex SHA-256 of the token. Matches sessions.token_hash.
export function hashParticipantToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Default expiry for a new participant session, from PARTICIPANT_SESSION_TTL_HOURS.
export function participantSessionExpiry(from: Date = currentTime()): Date {
  return new Date(from.getTime() + getEnv().PARTICIPANT_SESSION_TTL_HOURS * 3600 * 1000);
}

function baseOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: getEnv().isProduction,
    path: "/",
  };
}

// Call from a route handler or server action (not while a server component renders).
export async function setParticipantCookie(token: string, expiresAt: Date): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(PARTICIPANT_COOKIE_NAME, token, { ...baseOptions(), expires: expiresAt });
}

// The token from the current request, or null. The format is checked so that an
// obviously invalid value never reaches the database lookup.
export async function readParticipantToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(PARTICIPANT_COOKIE_NAME)?.value;
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return value;
}

export async function clearParticipantCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(PARTICIPANT_COOKIE_NAME, "", { ...baseOptions(), maxAge: 0 });
}
