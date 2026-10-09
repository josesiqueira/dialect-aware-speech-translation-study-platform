import { desc, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { adminAuditLog, rateLimitHits } from "@dialect/db";
import {
  ADMIN_COOKIE_NAME,
  clearRejectedAdminCookie,
  getAdminLoginState,
  getAdminSession,
  LOGIN_FAILURE_WINDOW_SECONDS,
  LOGIN_FAILURES_PER_ADDRESS,
  LOGIN_FAILURES_PER_WINDOW,
  LOGIN_WINDOW_SECONDS,
  requireAdmin,
  requireAdminPage,
  resetAdminSessionCacheForTests,
  verifyAdminPassword,
} from "@/lib/server/admin-auth";
import { sealAdminSession, unsealAdminSession } from "@/lib/server/admin-session";
import { resetEnvCacheForTests } from "@/lib/server/env";
import { jsonRequest, noParams, setupServerTestHarness } from "@/lib/server/test/database";
import { fakeCookies, fakeHeaders, RedirectSignal } from "@/lib/server/test/request-scope";
import { applyTestEnv, TEST_ENV } from "@/lib/server/test/setup";
import { POST as logout } from "../logout/route";
import { POST as login } from "./route";

const harness = setupServerTestHarness();
const LOGIN_URL = "http://localhost:3000/api/admin/login";
const LOGOUT_URL = "http://localhost:3000/api/admin/logout";

const attempt = (password: unknown, headers?: Record<string, string>) =>
  login(jsonRequest(LOGIN_URL, { body: { password }, headers }), noParams);

async function auditActions(): Promise<string[]> {
  const rows = await harness.database.db
    .select({ action: adminAuditLog.action })
    .from(adminAuditLog)
    .where(like(adminAuditLog.action, "admin.%"))
    .orderBy(desc(adminAuditLog.createdAt));
  return rows.map((row) => row.action);
}

async function clearState(): Promise<void> {
  await harness.database.db.delete(rateLimitHits);
}

describe("verifyAdminPassword", () => {
  it("accepts only the exact password", () => {
    expect(verifyAdminPassword(TEST_ENV.ADMIN_PASSWORD)).toBe(true);
    expect(verifyAdminPassword(`${TEST_ENV.ADMIN_PASSWORD} `)).toBe(false);
    expect(verifyAdminPassword("")).toBe(false);
    expect(verifyAdminPassword(undefined)).toBe(false);
    expect(verifyAdminPassword(12345)).toBe(false);
  });
});

describe("POST /api/admin/login", () => {
  it("rejects a wrong password with 401, sets no cookie and writes an audit row without the password", async () => {
    await clearState();
    const response = await attempt("definitely-wrong-password");
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(typeof body.error.message).toBe("string");
    expect(fakeCookies.lastWrite(ADMIN_COOKIE_NAME)).toBeUndefined();
    expect(response.headers.get("x-request-id")).toBeTruthy();

    const [row] = await harness.database.db
      .select()
      .from(adminAuditLog)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(1);
    expect(row.action).toBe("admin.login_failed");
    expect(JSON.stringify(row)).not.toContain("definitely-wrong-password");
    expect(harness.logLines.join("")).not.toContain("definitely-wrong-password");
  });

  it("accepts the right password and issues a sealed HttpOnly SameSite=Strict cookie", async () => {
    await clearState();
    const response = await attempt(TEST_ENV.ADMIN_PASSWORD);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const write = fakeCookies.lastWrite(ADMIN_COOKIE_NAME);
    expect(write?.name).toBe("dts_admin");
    expect(write?.options).toEqual({ httpOnly: true, sameSite: "strict", secure: false, path: "/", maxAge: 8 * 3600 });
    // The value is sealed: it does not contain the payload in readable form.
    expect(write?.value).not.toContain("admin");

    const session = await getAdminSession();
    expect(session).toMatchObject({ role: "admin", actorLabel: "admin" });
    expect(Object.keys(session ?? {}).sort()).toEqual(["actorLabel", "expiresAt", "issuedAt", "role"]);
    expect(new Date(session!.expiresAt).getTime() - new Date(session!.issuedAt).getTime()).toBe(8 * 3600 * 1000);
    expect((await auditActions())[0]).toBe("admin.login");
    // A successful login leaves no rate limit hit behind.
    expect(await harness.database.db.select().from(rateLimitHits)).toHaveLength(0);
  });

  it("uses the __Host- cookie name over https in production", async () => {
    await clearState();
    applyTestEnv({ NODE_ENV: "production", APP_URL: "https://study.example.org", APP_VERSION: "1.2.3" });
    resetEnvCacheForTests();
    const response = await login(
      jsonRequest("https://study.example.org/api/admin/login", { body: { password: TEST_ENV.ADMIN_PASSWORD } }),
      noParams,
    );
    expect(response.status).toBe(200);
    expect(fakeCookies.lastWrite(ADMIN_COOKIE_NAME)).toBeUndefined();
    // Secure, Path=/ and no Domain: what the __Host- prefix requires.
    expect(fakeCookies.lastWrite("__Host-dts_admin")?.options).toEqual({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
      maxAge: 8 * 3600,
    });
    expect(await getAdminSession()).not.toBeNull();
    // A cookie with the plain name is not read in this deployment.
    const sealed = fakeCookies.get("__Host-dts_admin")!.value;
    fakeCookies.reset();
    fakeCookies.setRequestCookie(ADMIN_COOKIE_NAME, sealed);
    expect(await getAdminSession()).toBeNull();
  });

  it("marks the cookie Secure in production and honors ADMIN_SESSION_TTL_HOURS", async () => {
    await clearState();
    applyTestEnv({ NODE_ENV: "production", ADMIN_SESSION_TTL_HOURS: "2" });
    resetEnvCacheForTests();
    const response = await attempt(TEST_ENV.ADMIN_PASSWORD);
    expect(response.status).toBe(200);
    expect(fakeCookies.lastWrite(ADMIN_COOKIE_NAME)?.options).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      maxAge: 7200,
    });
  });

  it("rejects a body without a password as a validation error", async () => {
    await clearState();
    const response = await login(jsonRequest(LOGIN_URL, { body: {} }), noParams);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a cross-origin login request", async () => {
    await clearState();
    const response = await attempt(TEST_ENV.ADMIN_PASSWORD, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(fakeCookies.lastWrite(ADMIN_COOKIE_NAME)).toBeUndefined();
  });

  it("always accepts the correct password, also after many wrong ones (no lockout)", async () => {
    await clearState();
    // Far more failures than any limit, as an attacker would send them.
    for (let i = 0; i < LOGIN_FAILURES_PER_WINDOW + 20; i += 1) {
      const status = (await attempt("wrong-password")).status;
      expect([401, 429]).toContain(status);
    }
    // The failures are over the rate: the next wrong password gets 429 ...
    expect((await attempt("wrong-password")).status).toBe(429);
    // ... and the correct password signs in at once, without waiting for a window.
    const response = await attempt(TEST_ENV.ADMIN_PASSWORD);
    expect(response.status).toBe(200);
    expect(await getAdminSession()).not.toBeNull();
  });

  it("answers failed attempts beyond the rate with 429 and does not write them to the audit log", async () => {
    await clearState();
    const failuresBefore = (await auditActions()).filter((action) => action === "admin.login_failed").length;
    for (let i = 0; i < LOGIN_FAILURES_PER_WINDOW; i += 1) {
      expect((await attempt("wrong-password")).status).toBe(401);
      harness.advanceSeconds(1);
    }
    const limited = await attempt("wrong-password");
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    // The answer still says that the password was wrong.
    expect(body.error.message).toContain("The password is not correct.");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    for (let i = 0; i < 10; i += 1) await attempt("wrong-password");

    // Exactly the failures inside the rate are in the audit log and in the hit table.
    const failuresAfter = (await auditActions()).filter((action) => action === "admin.login_failed").length;
    expect(failuresAfter - failuresBefore).toBe(LOGIN_FAILURES_PER_WINDOW);
    expect(await harness.database.db.select().from(rateLimitHits)).toHaveLength(LOGIN_FAILURES_PER_WINDOW);

    // After the window a wrong password is an ordinary 401 again.
    harness.advanceSeconds(LOGIN_FAILURE_WINDOW_SECONDS + 1);
    expect((await attempt("wrong-password")).status).toBe(401);
  });

  it("without TRUST_PROXY there is no per-address bucket: one client cannot use up a limit for everyone", async () => {
    await clearState();
    for (let i = 0; i < LOGIN_FAILURES_PER_ADDRESS + 3; i += 1) {
      expect((await attempt("wrong-password", { "x-forwarded-for": "203.0.113.77" })).status).toBe(401);
    }
    const rows = await harness.database.db.select().from(rateLimitHits);
    expect(new Set(rows.map((row) => row.bucketKey))).toEqual(new Set(["login:failed"]));
  });

  it("with TRUST_PROXY limits the failures of one address, stores only a keyed hash, and never refuses the correct password", async () => {
    await clearState();
    applyTestEnv({ TRUST_PROXY: "true" });
    resetEnvCacheForTests();
    const from = (address: string) => ({ "x-forwarded-for": address });
    await attempt("wrong-password", from("203.0.113.77"));
    const rows = await harness.database.db.select().from(rateLimitHits);
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.bucketKey).sort()).toEqual([expect.stringMatching(/^login:addr:[0-9a-f]{32}$/), "login:failed"]);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.77");

    for (let i = 1; i < LOGIN_FAILURES_PER_ADDRESS; i += 1) await attempt("wrong-password", from("203.0.113.77"));
    expect((await attempt("wrong-password", from("203.0.113.77"))).status).toBe(429);
    // Another address has its own limit.
    expect((await attempt("wrong-password", from("198.51.100.20"))).status).toBe(401);
    // The correct password is accepted from the limited address too.
    expect((await attempt(TEST_ENV.ADMIN_PASSWORD, from("203.0.113.77"))).status).toBe(200);
    // After the window the address can fail again with 401.
    harness.advanceSeconds(LOGIN_WINDOW_SECONDS + 1);
    expect((await attempt("wrong-password", from("203.0.113.77"))).status).toBe(401);
  });
});

describe("admin session verification", () => {
  it("rejects an expired session even when the cookie is still present", async () => {
    await clearState();
    expect((await attempt(TEST_ENV.ADMIN_PASSWORD)).status).toBe(200);
    expect(await getAdminSession()).not.toBeNull();
    harness.advanceSeconds(8 * 3600 + 1);
    expect(await getAdminSession()).toBeNull();
    await expect(requireAdmin()).rejects.toMatchObject({ code: "UNAUTHORIZED", httpStatus: 401 });
  });

  it("rejects a tampered cookie and a cookie sealed with another secret", async () => {
    await clearState();
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    const sealed = fakeCookies.get(ADMIN_COOKIE_NAME)!.value;

    const flipped = sealed.slice(0, 40) + (sealed[40] === "A" ? "B" : "A") + sealed.slice(41);
    fakeCookies.setRequestCookie(ADMIN_COOKIE_NAME, flipped);
    expect(await getAdminSession()).toBeNull();

    fakeCookies.setRequestCookie(ADMIN_COOKIE_NAME, "not-a-seal");
    expect(await getAdminSession()).toBeNull();

    const now = new Date();
    const forged = await sealAdminSession(
      { role: "admin", issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600_000).toISOString(), actorLabel: "admin" },
      "an-attacker-chosen-secret-of-sufficient-length",
    );
    fakeCookies.setRequestCookie(ADMIN_COOKIE_NAME, forged);
    expect(await getAdminSession()).toBeNull();

    fakeCookies.setRequestCookie(ADMIN_COOKIE_NAME, sealed);
    expect(await getAdminSession()).not.toBeNull();
  });

  it("ends every session when the admin password changes", async () => {
    await clearState();
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    expect(await getAdminSession()).not.toBeNull();
    applyTestEnv({ ADMIN_PASSWORD: "a new and different password" });
    resetEnvCacheForTests();
    expect(await getAdminSession()).toBeNull();
    // Back to the password the cookie was issued under: the cookie itself was intact.
    applyTestEnv();
    resetEnvCacheForTests();
    expect(await getAdminSession()).not.toBeNull();
  });

  it("rejects a correctly sealed payload that is not an admin session", async () => {
    const now = new Date();
    const sealed = await sealAdminSession(
      { role: "participant", issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600_000).toISOString(), actorLabel: "x" } as never,
      TEST_ENV.ADMIN_SESSION_SECRET,
    );
    expect(await unsealAdminSession(sealed, TEST_ENV.ADMIN_SESSION_SECRET)).toBeNull();
  });

  it("requireAdminPage redirects to the login page with the requested path", async () => {
    fakeHeaders.set("x-dts-pathname", "/admin/sessions?page=2");
    await expect(requireAdminPage()).rejects.toMatchObject({
      url: "/admin/login?next=%2Fadmin%2Fsessions%3Fpage%3D2",
    });
    await expect(requireAdminPage("https://evil.example/admin")).rejects.toBeInstanceOf(RedirectSignal);
    await expect(requireAdminPage("//evil.example")).rejects.toMatchObject({ url: "/admin/login?next=%2Fadmin" });

    await clearState();
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    await expect(requireAdminPage()).resolves.toMatchObject({ role: "admin" });
  });
});

describe("POST /api/admin/logout", () => {
  it("destroys the cookie and writes an audit row", async () => {
    await clearState();
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    expect(await getAdminSession()).not.toBeNull();

    const response = await logout(jsonRequest(LOGOUT_URL), noParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fakeCookies.lastWrite(ADMIN_COOKIE_NAME)).toMatchObject({ value: "", options: { maxAge: 0, httpOnly: true, sameSite: "strict", path: "/" } });
    expect(await getAdminSession()).toBeNull();
    expect((await auditActions())[0]).toBe("admin.logout");
  });

  it("ends the session on the server: the same cookie value is rejected after sign-out", async () => {
    await clearState();
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    const copied = fakeCookies.get(ADMIN_COOKIE_NAME)!.value;
    harness.advanceSeconds(5);
    await logout(jsonRequest(LOGOUT_URL), noParams);

    // Someone who copied the cookie before the sign-out presents it again.
    fakeCookies.setRequestCookie(ADMIN_COOKIE_NAME, copied);
    expect(await getAdminSession()).toBeNull();
    await expect(requireAdmin()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Also in a process that has not cached the sign-out time (another replica, a restart).
    resetAdminSessionCacheForTests();
    expect(await getAdminSession()).toBeNull();

    // The sign-out time is in the append-only audit log.
    const [row] = await harness.database.db
      .select()
      .from(adminAuditLog)
      .where(like(adminAuditLog.action, "admin.logout"))
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(1);
    expect(row.afterJson).toEqual({ sessionsValidAfter: harness.now.toISOString() });

    // A new sign-in after the sign-out works.
    harness.advanceSeconds(1);
    fakeCookies.reset();
    expect((await attempt(TEST_ENV.ADMIN_PASSWORD)).status).toBe(200);
    expect(await getAdminSession()).not.toBeNull();
  });

  it("a request without a session cannot end the sessions of the researcher", async () => {
    await clearState();
    harness.advanceSeconds(10);
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    const sealed = fakeCookies.get(ADMIN_COOKIE_NAME)!.value;
    fakeCookies.reset();
    harness.advanceSeconds(1);
    await logout(jsonRequest(LOGOUT_URL), noParams);
    resetAdminSessionCacheForTests();
    fakeCookies.setRequestCookie(ADMIN_COOKIE_NAME, sealed);
    expect(await getAdminSession()).not.toBeNull();
  });

  // Defect E2E-3. Browser A and browser B are signed in, B signs out. The cookie
  // of A still opens and has not expired, so proxy.ts lets it through, but the
  // full check refuses it. The login page decides with the full check.
  it("after a sign-out elsewhere the login page sees a refused cookie, not a session", async () => {
    await clearState();
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    const browserA = fakeCookies.get(ADMIN_COOKIE_NAME)!.value;
    harness.advanceSeconds(2);
    fakeCookies.reset();
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    harness.advanceSeconds(2);
    await logout(jsonRequest(LOGOUT_URL), noParams);

    fakeCookies.reset();
    fakeCookies.setRequestCookie(ADMIN_COOKIE_NAME, browserA);
    // The proxy check alone would accept this cookie.
    expect(
      await unsealAdminSession(browserA, TEST_ENV.ADMIN_SESSION_SECRET, harness.now),
    ).not.toBeNull();
    // The admin page refuses it and sends the browser to the login page ...
    await expect(requireAdminPage("/admin")).rejects.toMatchObject({ url: "/admin/login?next=%2Fadmin" });
    // ... and the login page does not send it back.
    expect(await getAdminLoginState()).toEqual({ session: null, rejectedCookie: true });

    // The refused cookie is removed on request, without another sign-out record.
    const before = await auditActions();
    const response = await logout(jsonRequest(`${LOGOUT_URL}?rejected-cookie-only=1`), noParams);
    expect(response.status).toBe(200);
    expect(fakeCookies.lastWrite(ADMIN_COOKIE_NAME)).toMatchObject({ value: "", options: { maxAge: 0 } });
    expect(await auditActions()).toEqual(before);
    expect(await getAdminLoginState()).toEqual({ session: null, rejectedCookie: false });
  });

  it("the login page state: a session for a valid cookie, nothing for no cookie", async () => {
    await clearState();
    expect(await getAdminLoginState()).toEqual({ session: null, rejectedCookie: false });
    // Later than the sign-outs of the tests above.
    harness.advanceSeconds(60);
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    const state = await getAdminLoginState();
    expect(state.session).toMatchObject({ role: "admin" });
    expect(state.rejectedCookie).toBe(false);
  });

  it("removing a refused cookie never ends a valid session", async () => {
    await clearState();
    // Later than the sign-outs of the tests above.
    harness.advanceSeconds(60);
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    const writesBefore = fakeCookies.writes.length;
    const auditBefore = await auditActions();
    expect(await clearRejectedAdminCookie()).toBe(false);
    await logout(jsonRequest(`${LOGOUT_URL}?rejected-cookie-only=1`), noParams);
    expect(fakeCookies.writes.length).toBe(writesBefore);
    expect(await auditActions()).toEqual(auditBefore);
    expect(await getAdminSession()).not.toBeNull();
  });

  it("a cookie sealed under an old password is refused and removed the same way", async () => {
    await clearState();
    // Later than the sign-outs of the tests above.
    harness.advanceSeconds(60);
    await attempt(TEST_ENV.ADMIN_PASSWORD);
    applyTestEnv({ ADMIN_PASSWORD: "a-new-admin-password-after-the-change" });
    resetEnvCacheForTests();
    await expect(requireAdminPage("/admin")).rejects.toBeInstanceOf(RedirectSignal);
    expect(await getAdminLoginState()).toEqual({ session: null, rejectedCookie: true });
    expect(await clearRejectedAdminCookie()).toBe(true);
    expect(fakeCookies.get(ADMIN_COOKIE_NAME)).toBeUndefined();
  });

  it("answers 200 without a session and writes no audit row", async () => {
    const before = (await auditActions()).length;
    const response = await logout(jsonRequest(LOGOUT_URL), noParams);
    expect(response.status).toBe(200);
    expect((await auditActions()).length).toBe(before);
  });
});
