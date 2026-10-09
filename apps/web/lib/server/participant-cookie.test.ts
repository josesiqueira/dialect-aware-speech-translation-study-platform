import { describe, expect, it } from "vitest";
import {
  clearParticipantCookie,
  generateParticipantToken,
  hashParticipantToken,
  PARTICIPANT_COOKIE_NAME,
  participantSessionExpiry,
  readParticipantToken,
  setParticipantCookie,
} from "./participant-cookie";
import { resetEnvCacheForTests } from "./env";
import { fakeCookies } from "./test/request-scope";
import { applyTestEnv } from "./test/setup";

describe("participant token", () => {
  it("is 32 random bytes in base64url", () => {
    const token = generateParticipantToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(generateParticipantToken()).not.toBe(token);
  });

  it("hashes to a stable SHA-256 hex value", () => {
    // Known SHA-256 of "abc".
    expect(hashParticipantToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const token = generateParticipantToken();
    expect(hashParticipantToken(token)).toBe(hashParticipantToken(token));
    expect(hashParticipantToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashParticipantToken(token)).not.toBe(hashParticipantToken(generateParticipantToken()));
  });
});

describe("participant cookie", () => {
  it("is HttpOnly, SameSite=Lax, Path=/ and not Secure outside production", async () => {
    const token = generateParticipantToken();
    const expiresAt = new Date("2030-01-01T00:00:00Z");
    await setParticipantCookie(token, expiresAt);
    expect(fakeCookies.lastWrite(PARTICIPANT_COOKIE_NAME)).toEqual({
      name: "dts_participant",
      value: token,
      options: { httpOnly: true, sameSite: "lax", secure: false, path: "/", expires: expiresAt },
    });
    expect(await readParticipantToken()).toBe(token);
  });

  it("is Secure in production", async () => {
    applyTestEnv({ NODE_ENV: "production" });
    resetEnvCacheForTests();
    await setParticipantCookie(generateParticipantToken(), new Date("2030-01-01T00:00:00Z"));
    expect(fakeCookies.lastWrite(PARTICIPANT_COOKIE_NAME)?.options.secure).toBe(true);
  });

  it("ignores a malformed cookie value and clears the cookie", async () => {
    fakeCookies.setRequestCookie(PARTICIPANT_COOKIE_NAME, "not a token");
    expect(await readParticipantToken()).toBeNull();

    const token = generateParticipantToken();
    fakeCookies.setRequestCookie(PARTICIPANT_COOKIE_NAME, token);
    expect(await readParticipantToken()).toBe(token);
    await clearParticipantCookie();
    expect(fakeCookies.lastWrite(PARTICIPANT_COOKIE_NAME)?.options).toMatchObject({ maxAge: 0, httpOnly: true, path: "/" });
    expect(await readParticipantToken()).toBeNull();
  });

  it("computes the default expiry from PARTICIPANT_SESSION_TTL_HOURS", () => {
    const from = new Date("2026-10-03T10:00:00Z");
    expect(participantSessionExpiry(from).toISOString()).toBe("2026-10-04T10:00:00.000Z");
  });
});
