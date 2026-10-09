// Signs in once through the real login page and saves the browser storage state
// for the admin project (Playwright guide "Authentication": setup project).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { ADMIN_STORAGE_STATE, adminPassword } from "./support/env";

setup("sign in as the researcher", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel("Password").fill(adminPassword());
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  mkdirSync(path.dirname(ADMIN_STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
});
