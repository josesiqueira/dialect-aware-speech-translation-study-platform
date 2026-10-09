// Admin authentication (spec 39, 157.1): redirect, refusal and sign-in. These
// tests use a browser without the saved admin session, so they go through the
// real login page themselves.
import { expect, test } from "@playwright/test";
import { adminPassword } from "./support/env";

test.use({ storageState: { cookies: [], origins: [] } });

test("signed out: /admin redirects to the login page and the admin API answers 401", async ({ page, request }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login\?next=(%2F|\/)admin$/);
  await expect(page.getByRole("heading", { level: 1, name: "Research Dashboard" })).toBeVisible();

  for (const path of ["/api/admin/dashboard", "/api/admin/sessions", "/api/admin/settings"]) {
    const response = await request.get(path);
    expect(response.status(), `GET ${path} without a session`).toBe(401);
  }
});

test("a wrong password shows the inline error, the right one reaches the Dashboard", async ({ page }) => {
  await page.goto("/admin/login");
  const password = page.getByLabel("Password");

  await password.fill("certainly-not-the-password");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Incorrect password" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/login/);
  expect((await page.context().request.get("/api/admin/dashboard")).status()).toBe(401);

  // A wrong attempt does not lock the researcher out: the right password works at once.
  await password.fill(adminPassword());
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  // The session cookie is not readable by scripts, and in this production build it
  // is Secure and SameSite=Strict. The __Host- name prefix is used when APP_URL is
  // an https address (adminCookieName in lib/server/admin-session.ts), which the
  // plain http address of this environment is not.
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((cookie) => cookie.httpOnly && cookie.name.includes("admin"));
  expect(sessionCookie, "an HttpOnly admin session cookie").toBeTruthy();
  expect(sessionCookie?.secure).toBe(true);
  expect(sessionCookie?.sameSite).toBe("Strict");
  expect(sessionCookie?.path).toBe("/");

  // The signed-in browser can call the admin API.
  expect((await page.context().request.get("/api/admin/dashboard")).status()).toBe(200);
});

// Sign Out is tested in admin-12-sign-out.spec.ts, at the very end: signing out
// ends every admin session that was issued before, the saved one included.
