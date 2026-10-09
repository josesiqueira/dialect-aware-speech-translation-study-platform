// Accessibility smoke check (spec 136, WCAG 2.1 AA basics) of every admin page
// and of the participant welcome page, with role-based assertions only:
// exactly one h1, a main landmark, every button, link and form control has an
// accessible name, and every image has a text alternative.
//
// This is a smoke check, not an audit: it finds missing names and landmarks, it
// does not measure contrast or test a screen reader.
import { expect, test, type Page } from "@playwright/test";

const ADMIN_PAGES: Array<{ path: string; heading: string }> = [
  { path: "/admin", heading: "Dashboard" },
  { path: "/admin/sessions", heading: "Sessions" },
  { path: "/admin/review", heading: "Review & Transcription" },
  { path: "/admin/study-flow", heading: "Study Flow" },
  { path: "/admin/ai-pipeline", heading: "AI Pipeline" },
  { path: "/admin/processing", heading: "Processing Runs" },
  { path: "/admin/questionnaires", heading: "Questionnaires" },
  { path: "/admin/data", heading: "Data & Export" },
  { path: "/admin/settings", heading: "Settings" },
];

/** Returns a description of every interactive element without an accessible name. */
async function unnamedControls(page: Page): Promise<string[]> {
  const problems: string[] = [];
  for (const role of ["button", "link", "textbox", "combobox", "checkbox", "radio", "spinbutton", "searchbox", "img"] as const) {
    const all = page.getByRole(role);
    const named = page.getByRole(role, { name: /\S/ });
    const total = await all.count();
    const withName = await named.count();
    if (total !== withName) {
      // Name the first offender, to make the report useful.
      for (let index = 0; index < total; index += 1) {
        const element = all.nth(index);
        const snapshot = await element.ariaSnapshot();
        if (!/"\S/.test(snapshot.split("\n")[0] ?? "")) {
          const html = await element.evaluate((node) => node.outerHTML.slice(0, 160));
          problems.push(`${role} without an accessible name: ${html}`);
        }
      }
    }
  }
  return problems;
}

async function checkPage(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  expect(await page.locator("html").getAttribute("lang"), "the page declares its language").toMatch(/^[a-z]{2}/);
  expect(await page.title(), "the page has a title").not.toBe("");
  expect(await unnamedControls(page)).toEqual([]);
}

for (const { path, heading } of ADMIN_PAGES) {
  test(`${path}: one h1, landmarks and named controls`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    // The page content is loaded by the browser after the heading: wait for it.
    await expect(page.getByRole("main").getByText(/Loading/)).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Skip to main content" })).toHaveCount(1);
    // Each admin page names itself in the tab title.
    await expect(page).toHaveTitle(`${heading} | Research Dashboard`);
    await checkPage(page);
  });
}

test("/admin/sessions with a session selected: named controls in Session Detail", async ({ page }) => {
  await page.goto("/admin/sessions");
  await page.getByRole("main").getByRole("button", { name: /^P-\w+ / }).first().click();
  await expect(page.getByRole("region", { name: "4. Utterances" })).toBeVisible();
  await checkPage(page);
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/admin/login: one h1, a labelled password field and a named button", async ({ page }) => {
    await page.goto("/admin/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
    expect(await unnamedControls(page)).toEqual([]);
  });

  test("the participant welcome page: one h1, main landmark and named controls", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await checkPage(page);
    // The tab title is neutral: it does not tell participants what the study looks for.
    expect(await page.title()).not.toMatch(/dialect|murre/i);
    // The language choice is a named group of named buttons.
    await expect(page.getByRole("banner").getByRole("group")).toHaveAccessibleName(/\S/);
  });
});
