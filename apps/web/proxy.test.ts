import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_COOKIE_NAME_HOST_PREFIXED,
  adminCookieName,
  adminPasswordTag,
  safeAdminNextPath,
  sealAdminSession,
} from "./lib/server/admin-session";
import { buildContentSecurityPolicy } from "./lib/server/security-headers";
import { TEST_ENV } from "./lib/server/test/setup";
import { config, proxy } from "./proxy";

const BASE = "http://localhost:3000";

async function sealedCookie(
  options: { expiresInSeconds?: number; secret?: string; password?: string | null } = {},
): Promise<string> {
  const now = Date.now();
  const expiresIn = options.expiresInSeconds ?? 3600;
  return sealAdminSession(
    {
      role: "admin",
      issuedAt: new Date(Math.min(now, now + expiresIn * 1000) - 1000).toISOString(),
      expiresAt: new Date(now + expiresIn * 1000).toISOString(),
      actorLabel: "admin",
    },
    options.secret ?? TEST_ENV.ADMIN_SESSION_SECRET,
    // Bound to the admin password, like a cookie issued by the login route.
    options.password === null
      ? undefined
      : adminPasswordTag(options.password ?? TEST_ENV.ADMIN_PASSWORD, options.secret ?? TEST_ENV.ADMIN_SESSION_SECRET),
  );
}

function request(path: string, cookie?: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    headers: { ...headers, ...(cookie ? { cookie: `${ADMIN_COOKIE_NAME}=${cookie}` } : {}) },
  });
}

describe("admin cookie name", () => {
  it("has the __Host- prefix over https in production and the plain name otherwise", () => {
    expect(adminCookieName({ NODE_ENV: "production", APP_URL: "https://study.example.org" })).toBe("__Host-dts_admin");
    expect(ADMIN_COOKIE_NAME_HOST_PREFIXED).toBe("__Host-dts_admin");
    // A browser refuses a __Host- cookie from a plain http origin, so http keeps the plain name.
    expect(adminCookieName({ NODE_ENV: "production", APP_URL: "http://localhost:3000" })).toBe("dts_admin");
    expect(adminCookieName({ NODE_ENV: "development", APP_URL: "https://study.example.org" })).toBe("dts_admin");
    expect(adminCookieName({ NODE_ENV: "development", APP_URL: "http://localhost:3000" })).toBe("dts_admin");
  });
});

describe("proxy admin gate and the password binding", () => {
  it("rejects a cookie that was issued under another admin password, or without a password tag", async () => {
    const current = await sealedCookie();
    expect((await proxy(request("/admin/sessions", current))).status).toBe(200);
    const old = await sealedCookie({ password: "the-password-before-the-change" });
    expect((await proxy(request("/admin/sessions", old))).status).toBe(307);
    const unbound = await sealedCookie({ password: null });
    expect((await proxy(request("/api/admin/sessions", unbound))).status).toBe(401);
  });

  it("reads the __Host- cookie in production over https and ignores the plain name there", async () => {
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = "production";
    env.APP_URL = "https://study.example.org";
    const cookie = await sealedCookie();
    const withName = (name: string) =>
      new NextRequest("https://study.example.org/admin/sessions", { headers: { cookie: `${name}=${cookie}` } });
    expect((await proxy(withName("__Host-dts_admin"))).status).toBe(200);
    expect((await proxy(withName("dts_admin"))).status).toBe(307);
  });
});

describe("proxy admin gate", () => {
  it("redirects an unauthenticated admin page request to the login page with next", async () => {
    const response = await proxy(request("/admin/sessions?page=2"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${BASE}/admin/login?next=%2Fadmin%2Fsessions%3Fpage%3D2`);
    expect((await proxy(request("/admin"))).headers.get("location")).toBe(`${BASE}/admin/login?next=%2Fadmin`);
  });

  // Defect E2E-3: the check here needs no database, so it is weaker than the
  // check of the pages (a cookie issued before a sign-out passes here). A
  // redirect from the login page to /admin on this check looped with the
  // redirect of requireAdminPage() back to the login page.
  it("never redirects away from the login page, with or without a cookie", async () => {
    const anonymous = await proxy(request("/admin/login"));
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("location")).toBeNull();

    for (const path of ["/admin/login", "/admin/login?next=%2Fadmin%2Fsessions"]) {
      const withCookie = await proxy(request(path, await sealedCookie()));
      expect(withCookie.status).toBe(200);
      expect(withCookie.headers.get("location")).toBeNull();
      // A cookie that is valid here is left alone.
      expect(withCookie.headers.get("set-cookie")).toBeNull();
    }
  });

  it("removes a cookie that fails its check, and still shows the login page (no loop after a password change)", async () => {
    const rejected = [
      "forged",
      await sealedCookie({ password: "the-password-before-the-change" }),
      await sealedCookie({ expiresInSeconds: -10 }),
      await sealedCookie({ secret: "some-other-secret-some-other-secret-1234" }),
    ];
    for (const cookie of rejected) {
      // An admin page: redirect to the login page, and the cookie is removed.
      const page = await proxy(request("/admin/sessions", cookie));
      expect(page.status).toBe(307);
      expect(page.headers.get("location")).toBe(`${BASE}/admin/login?next=%2Fadmin%2Fsessions`);
      expect(page.headers.get("set-cookie")).toMatch(/^dts_admin=;.*Max-Age=0/);
      expect(page.headers.get("set-cookie")).toMatch(/HttpOnly/i);
      expect(page.headers.get("set-cookie")).toMatch(/SameSite=strict/i);

      // The login page: shown, not redirected, and the cookie is removed.
      const login = await proxy(request("/admin/login?next=%2Fadmin%2Fsessions", cookie));
      expect(login.status).toBe(200);
      expect(login.headers.get("location")).toBeNull();
      expect(login.headers.get("set-cookie")).toMatch(/^dts_admin=;.*Max-Age=0/);

      // The admin API: 401, and the cookie is removed.
      const api = await proxy(request("/api/admin/sessions", cookie));
      expect(api.status).toBe(401);
      expect(api.headers.get("set-cookie")).toMatch(/^dts_admin=;.*Max-Age=0/);
    }
    // Without a cookie there is nothing to remove.
    expect((await proxy(request("/admin/sessions"))).headers.get("set-cookie")).toBeNull();
    expect((await proxy(request("/api/admin/sessions"))).headers.get("set-cookie")).toBeNull();
  });

  it("lets an authenticated admin page request through", async () => {
    const response = await proxy(request("/admin/sessions", await sealedCookie()));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns 401 JSON for admin API requests without a valid session", async () => {
    const response = await proxy(request("/api/admin/sessions"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
    expect(response.headers.get("cache-control")).toBe("no-store, private");

    expect((await proxy(request("/api/admin/sessions", "forged"))).status).toBe(401);
    expect((await proxy(request("/api/admin/sessions", await sealedCookie({ expiresInSeconds: -10 })))).status).toBe(401);
    expect((await proxy(request("/api/admin/sessions", await sealedCookie({ secret: "some-other-secret-some-other-secret-1234" })))).status).toBe(401);
    expect((await proxy(request("/api/admin/sessions", await sealedCookie()))).status).toBe(200);
  });

  it("does not gate the login API, public API routes or participant pages", async () => {
    expect((await proxy(request("/api/admin/login"))).status).toBe(200);
    expect((await proxy(request("/api/admin/logout"))).status).toBe(401);
    expect((await proxy(request("/api/health"))).status).toBe(200);
    expect((await proxy(request("/api/study/session"))).status).toBe(200);
    expect((await proxy(request("/study"))).status).toBe(200);
    // A path that only starts with the same letters is not an admin path.
    expect((await proxy(request("/administrator"))).status).toBe(200);
  });
});

describe("proxy headers", () => {
  it("sets a nonce based CSP on pages and forwards nonce and path to the app", async () => {
    const response = await proxy(request("/study?x=1", undefined, { "x-dts-pathname": "/admin/forged" }));
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Next.js forwards overridden request headers with this prefix.
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(response.headers.get("x-middleware-request-x-dts-pathname")).toBe("/study?x=1");
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(csp);

    const second = await proxy(request("/study"));
    expect(second.headers.get("content-security-policy")).not.toBe(csp);
  });

  it("does not add the page CSP to API responses", async () => {
    expect((await proxy(request("/api/health"))).headers.get("content-security-policy")).toBeNull();
  });

  it("matches pages and API routes but not build assets", () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    expect(pattern.test("/admin/sessions")).toBe(true);
    expect(pattern.test("/api/admin/sessions")).toBe(true);
    expect(pattern.test("/_next/static/chunks/main.js")).toBe(false);
    expect(pattern.test("/_next/image")).toBe(false);
    expect(pattern.test("/icon.svg")).toBe(false);
  });

  // A matched request has its body cut at 10 MB by Next.js, so the audio upload
  // routes are left out. Each of them checks access itself (see proxy.ts).
  it("leaves out exactly the audio upload routes", () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ["/api/study/session", "/api/study/utterances/abc/audio", "/api/demo/recordings", "/api/admin/ai/test"]) {
      expect(pattern.test(path), path).toBe(false);
    }
    for (const path of [
      "/api/demo/session",
      "/api/demo/recordings/abc/run",
      "/api/demo/recordings-other",
      "/api/demo/media/abc",
      "/api/admin/ai/test/other",
      "/api/admin/ai/tests",
      "/api/admin/ai/configs",
      "/api/admin/ai",
      "/api/admin/sessions",
      "/api/studyx",
      "/demo",
      "/admin/ai-pipeline",
    ]) {
      expect(pattern.test(path), path).toBe(true);
    }
  });
});

describe("buildContentSecurityPolicy", () => {
  it("allows unsafe-eval and websockets only in development", () => {
    const production = buildContentSecurityPolicy({ nonce: "abc", isDevelopment: false, upgradeInsecureRequests: true });
    expect(production).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' blob: data:; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
        "upgrade-insecure-requests",
    );
    const development = buildContentSecurityPolicy({ nonce: "abc", isDevelopment: true, upgradeInsecureRequests: false });
    expect(development).toContain("'unsafe-eval'");
    expect(development).toContain("connect-src 'self' ws: wss:");
    expect(development).not.toContain("upgrade-insecure-requests");
  });
});

describe("safeAdminNextPath", () => {
  it("accepts the Demo Mode page and its query string, and nothing else outside /admin", () => {
    expect(safeAdminNextPath("/demo")).toBe("/demo");
    expect(safeAdminNextPath("/demo?condition=preserve")).toBe("/demo?condition=preserve");
    for (const bad of [
      "/demo/other",
      "/demonstration",
      "/demo\\evil.example",
      "/demo?to=\\evil.example",
      "//evil.example/demo",
      "https://evil.example/demo",
      "demo",
      "/",
    ]) {
      expect(safeAdminNextPath(bad)).toBe("/admin");
    }
  });

  it("accepts only local admin paths", () => {
    expect(safeAdminNextPath("/admin/review?tab=queue")).toBe("/admin/review?tab=queue");
    expect(safeAdminNextPath("/admin")).toBe("/admin");
    for (const bad of [null, "", "https://evil.example", "//evil.example/admin", "/study", "/administrator", "/admin/login", "/admin/login?next=/admin", "/admin\\evil"]) {
      expect(safeAdminNextPath(bad)).toBe("/admin");
    }
  });
});
