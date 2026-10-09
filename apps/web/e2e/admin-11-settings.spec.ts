// Settings (spec 57, docs/ADMIN.md "Settings"). This file runs last among the
// admin specs: its final test deletes the TEST and DEMO data of the e2e database.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { getJson, openAdminPage, testSessions } from "./support/admin";

test.describe.configure({ mode: "serial" });

/** The value next to a term of the read-only status cards. Every term is used once on the page. */
function value(page: Page, term: string): Locator {
  return page.getByRole("main").locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}

/** The first Save button after a card heading. */
function saveButtonOf(page: Page, heading: string): Locator {
  return page.locator(`xpath=//h2[normalize-space()="${heading}"]/following::button[normalize-space()="Save"][1]`);
}

test("the status cards show database, storage, AI provider and worker", async ({ page }) => {
  await openAdminPage(page, "/admin/settings", "Settings");

  const main = page.getByRole("main");
  for (const heading of ["Database", "Media storage", "AI provider", "Application"]) {
    await expect(main.getByRole("heading", { level: 2, name: heading, exact: true })).toBeVisible();
  }

  // Database.
  await expect(main.getByText("Connected", { exact: true })).toBeVisible();
  await expect(value(page, "Migration status")).toContainText("Up to date");
  await expect(value(page, "Migration status")).toContainText(/(\d+) applied of \1/);

  // Media storage.
  await expect(main.getByText("Accessible", { exact: true })).toBeVisible();
  await expect(value(page, "Driver")).toHaveText("local");
  await expect(value(page, "Connectivity")).toHaveText("Readable and writable");
  await expect(value(page, "ffmpeg")).toContainText(/ffmpeg \d/);

  // AI provider: no key in this environment, and no key is ever printed.
  await expect(value(page, "OpenAI API key")).toContainText("Not configured");
  await expect(value(page, "Providers")).toContainText("mock: available");
  await expect(main).not.toContainText(/sk-[A-Za-z0-9]{8,}/);

  // Application and worker.
  await expect(main.getByText("Worker healthy", { exact: true })).toBeVisible();
  await expect(value(page, "App version")).toHaveText("0.1.0-e2e");
  await expect(value(page, "Environment")).toHaveText("production");
  await expect(value(page, "Worker status")).toContainText("worker-e2e: running");
});

test("Allow new sessions opens and closes the public welcome page, and is left as it was found", async ({ page, browser }) => {
  await openAdminPage(page, "/admin/settings", "Settings");
  const request = page.context().request;
  const allow = page.getByRole("checkbox", { name: "Allow new sessions" });
  const save = saveButtonOf(page, "Study operational state");

  // The seed leaves research collection off. The page shows the stored value, whatever it is.
  const initial = (await getJson<{ study: { allowNewSessions: boolean } }>(request, "/api/admin/dashboard")).study.allowNewSessions;
  if (initial) await expect(allow).toBeChecked();
  else await expect(allow).not.toBeChecked();
  await expect(save).toBeDisabled();

  const setAllow = async (on: boolean) => {
    if (on) await allow.check();
    else await allow.uncheck();
    await save.click();
    await expect(save).toBeDisabled();
    await expect
      .poll(async () => (await getJson<{ study: { allowNewSessions: boolean } }>(request, "/api/admin/dashboard")).study.allowNewSessions)
      .toBe(on);
  };

  // A visitor without any session looks at the welcome page.
  const visitorContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const visitor = await visitorContext.newPage();
  const closedMessage = visitor.getByText("This study is not currently accepting new participants.");
  const begin = visitor.getByRole("button", { name: "Begin" });
  const lookAtWelcomePage = async () => {
    await visitor.goto("/");
    await visitor.getByRole("button", { name: "English" }).click();
    await expect(visitor.getByRole("heading", { level: 1 })).toBeVisible();
  };
  try {
    // On: the welcome page offers to begin. (The current protocol has no example
    // text any more after the Study Flow spec, so nothing else keeps the study closed.)
    await setAllow(true);
    await lookAtWelcomePage();
    await expect(begin).toBeVisible();
    await expect(closedMessage).toHaveCount(0);

    // Off: the welcome page says so, and the server refuses a new research session.
    await setAllow(false);
    await lookAtWelcomePage();
    await expect(closedMessage).toBeVisible();
    await expect(begin).toHaveCount(0);
    const refused = await visitorContext.request.post("/api/study/sessions", {
      headers: { Origin: new URL(page.url()).origin },
      data: { locale: "en" },
    });
    expect(refused.status()).toBeGreaterThanOrEqual(400);
    expect(refused.status()).toBeLessThan(500);
  } finally {
    // Back to the state the test found.
    await page.reload();
    const current = (await getJson<{ study: { allowNewSessions: boolean } }>(request, "/api/admin/dashboard")).study.allowNewSessions;
    if (current !== initial) await setAllow(initial);
    await visitorContext.close();
  }
  if (initial) await expect(allow).toBeChecked();
  else await expect(allow).not.toBeChecked();
});

test("Danger zone: deleting TEST and DEMO data needs the typed phrase and empties the test corpus", async ({ page }) => {
  const request = page.context().request;
  const before = await testSessions(request);
  expect(before.length).toBeGreaterThanOrEqual(3);

  await openAdminPage(page, "/admin/settings", "Settings");
  const danger = page.getByRole("region", { name: "Danger zone" });
  await expect(danger).toContainText("It never touches research data.");
  await expect(danger.getByRole("checkbox", { name: /^TEST/ })).toBeChecked();
  await expect(danger.getByRole("checkbox", { name: /^TEST/ })).toHaveAccessibleName(
    new RegExp(`TEST\\s*${before.length} session${before.length === 1 ? "" : "s"}$`),
  );

  await danger.getByRole("button", { name: /^Delete TEST and DEMO data/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("DELETE TEST AND DEMO DATA");
  const confirm = dialog.getByRole("button", { name: /^Delete/ });
  const phrase = dialog.getByRole("textbox");

  // The confirm button stays disabled without the exact phrase.
  await expect(confirm).toBeDisabled();
  await phrase.fill("delete test and demo data");
  await expect(confirm).toBeDisabled();
  await phrase.fill("DELETE TEST AND DEMO DAT");
  await expect(confirm).toBeDisabled();
  await phrase.fill("DELETE TEST AND DEMO DATA");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  // The number covers the TEST sessions and the DEMO sessions of the demo spec, when that ran before.
  const deleted = danger.getByText(/Deleted [\d,]+ sessions?, [\d,]+ utterances? and [\d,]+ files?\./);
  await expect(deleted).toBeVisible();
  const deletedSessions = Number(/Deleted ([\d,]+) sessions?/.exec(await deleted.innerText())?.[1]?.replaceAll(",", ""));
  expect(deletedSessions).toBeGreaterThanOrEqual(before.length);
  await expect(deleted).not.toContainText("could not be removed");
  await expect(danger.getByRole("checkbox", { name: /^TEST/ })).toHaveAccessibleName(/TEST\s*0 sessions/);

  // The sample sessions are gone from the list.
  expect(await testSessions(request)).toEqual([]);
  await openAdminPage(page, "/admin/sessions", "Sessions");
  await expect(page.getByText("No sessions match the selected filters.")).toBeVisible();
  for (const session of before) {
    await expect(page.getByRole("button", { name: new RegExp(`^${session.participantCode} `) })).toHaveCount(0);
  }

  // The Dashboard counts are at zero, for research as before and now for TEST as well.
  await openAdminPage(page, "/admin", "Dashboard");
  const apart = page.getByRole("paragraph").filter({ hasText: "Not included in the numbers above" });
  await expect(apart).toContainText("TEST 0 sessions, 0 completed, 0 utterances");
  await expect(apart).toContainText("DEMO 0 sessions, 0 completed, 0 utterances");
  await expect(page.getByRole("article").filter({ has: page.getByText("Participants started", { exact: true }) })).toContainText(
    "research sessions since the start of the study",
  );

  // Study content is kept: protocols, prompts and model configurations.
  const status = page.getByRole("region", { name: "Status" });
  await expect(status).toContainText(/v2 Initial study flow/);
  await expect(status).toContainText(/translation_default v\d+/);
});

// The reset also removes the queue jobs of the deleted sessions (the automatic
// ASR jobs that were queued when a recording was submitted and failed without an
// API key; they belong to no batch), so nothing of them is counted any more.
test("after the reset the Dashboard reports no processing errors", async ({ page }) => {
  const dashboard = await getJson<{ processingErrors: { failedJobs: number; failedModelRuns: number } }>(
    page.context().request,
    "/api/admin/dashboard",
  );
  expect(dashboard.processingErrors).toMatchObject({ failedJobs: 0, failedModelRuns: 0 });
  await openAdminPage(page, "/admin", "Dashboard");
  await expect(page.getByRole("article").filter({ has: page.getByText("Processing errors", { exact: true }) })).toContainText(
    "0 jobs, 0 model runs",
  );
});
