// Sign Out (spec 39). This file runs last among the admin specs, after the
// Settings spec that deletes the TEST and DEMO data: signing out ends every admin
// session issued before that moment (apps/web/lib/server/admin-auth.ts), so the
// saved session of the other admin specs stops working here, on purpose.
//
// The two tests run in order.
import { expect, test } from "@playwright/test";
import { adminPassword } from "./support/env";

test.describe.configure({ mode: "serial" });

test("Sign Out returns to the login page, and /admin and the admin API are closed again", async ({ page, browser }) => {
  // The saved session of this run still works.
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  // A second researcher browser signs in through the login page and signs out.
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const otherPage = await other.newPage();
  try {
    await otherPage.goto("/admin/login");
    await otherPage.getByLabel("Password").fill(adminPassword());
    await otherPage.getByRole("button", { name: "Sign In" }).click();
    await expect(otherPage.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    expect((await other.request.get("/api/admin/dashboard")).status()).toBe(200);

    await otherPage.getByRole("button", { name: "Sign Out" }).click();
    await expect(otherPage).toHaveURL(/\/admin\/login/);
    await expect(otherPage.getByLabel("Password")).toBeVisible();

    // That browser is signed out: /admin redirects again and the API answers 401.
    await otherPage.goto("/admin");
    await expect(otherPage).toHaveURL(/\/admin\/login\?next=(%2F|\/)admin$/);
    expect((await other.request.get("/api/admin/dashboard")).status()).toBe(401);
  } finally {
    await other.close();
  }

  // The session that was issued before the sign-out is refused by the API as well.
  await expect.poll(async () => (await page.context().request.get("/api/admin/dashboard")).status()).toBe(401);
});

// A browser that still holds a session cookie issued before a sign-out elsewhere:
// proxy.ts lets the cookie through (it unseals and has not expired), the page
// refuses it (issued before the sign-out), and the login page is shown. The proxy
// never redirects away from the login page, so the two cannot loop.
test("a browser with a session from before the sign-out is sent to the login page", async ({ page }) => {
  expect((await page.context().request.get("/api/admin/dashboard")).status()).toBe(401);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login\?next=(%2F|\/)admin$/);
  await expect(page.getByLabel("Password")).toBeVisible();
  // The login page stays put when it is opened directly with the refused cookie.
  await page.goto("/admin/login");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByLabel("Password")).toBeVisible();
  // The login page asks the server to remove the refused cookie.
  await expect
    .poll(async () => (await page.context().cookies()).filter((cookie) => cookie.name.endsWith("dts_admin")).length)
    .toBe(0);

  // Signing in again works and leads to the Dashboard.
  await page.getByLabel("Password").fill(adminPassword());
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  // A signed-in browser that opens the login page is sent on to the admin.
  await page.goto("/admin/login");
  await expect(page).toHaveURL(/\/admin$/);
});
