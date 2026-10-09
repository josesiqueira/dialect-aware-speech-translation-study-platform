// Dashboard (spec 42, 157.2): operational numbers only, TEST data counted apart.
import { expect, test } from "@playwright/test";
import { getJson, openAdminPage, testSessions } from "./support/admin";

type Dashboard = {
  participants: { started: number; completed: number };
  otherModes: Record<"demo" | "test", { sessions: number; completed: number; utterances: number }>;
};

test("the cards count research sessions only, and TEST sessions are reported apart with their label", async ({ page }) => {
  await openAdminPage(page, "/admin", "Dashboard");
  const request = page.context().request;
  const sessions = await testSessions(request);
  const dashboard = await getJson<Dashboard>(request, "/api/admin/dashboard");

  // No research session exists in the e2e database: every research card is zero.
  const card = (label: string) => page.getByRole("article").filter({ has: page.getByText(label, { exact: true }) });
  await expect(card("Participants started")).toContainText("research sessions since the start of the study");
  await expect(card("Participants started").getByText("0", { exact: true }).first()).toBeVisible();
  await expect(card("Consented")).toContainText("of 0 started");
  await expect(card("Completed")).toContainText("0 abandoned, 0 withdrawn");
  await expect(card("Completion rate")).toContainText("n/a");
  await expect(card("Utterances").getByText("0", { exact: true })).toBeVisible();
  await expect(card("Source audio")).toContainText("00:00");
  await expect(card("Awaiting review").getByText("0", { exact: true })).toBeVisible();
  await expect(card("Flagged")).toContainText("0 / 0");
  expect(dashboard.participants.started).toBe(0);

  // The TEST sessions are named in their own line, consistent with the session list.
  const utterances = sessions.reduce((sum, session) => sum + session.utteranceCount, 0);
  const completed = sessions.filter((session) => session.status === "completed").length;
  expect(dashboard.otherModes.test.sessions).toBe(sessions.length);
  const apart = page.getByRole("paragraph").filter({ hasText: "Not included in the numbers above" });
  await expect(apart).toContainText(
    new RegExp(`TEST ${sessions.length} sessions?, ${completed} completed, ${utterances} utterances?`),
  );
  await expect(apart).toContainText(/DEMO \d+ sessions?, \d+ completed, \d+ utterances?/);

  // Recent activity labels the sample sessions as TEST.
  const recent = page.getByRole("region", { name: "Recent activity" });
  await expect(recent.getByRole("listitem").filter({ hasText: sessions[0]!.participantCode }).first()).toContainText("TEST");
});

test("the status area shows protocol, AI configurations, worker, storage and database", async ({ page }) => {
  await openAdminPage(page, "/admin", "Dashboard");
  const status = page.getByRole("region", { name: "Status" });
  const row = (term: string) => status.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");

  // The seed leaves research collection switched off. The row says what the API reports.
  const dashboard = await getJson<{ study: { acceptingNewSessions: boolean } }>(page.context().request, "/api/admin/dashboard");
  await expect(row("Study")).toContainText(
    dashboard.study.acceptingNewSessions ? "New sessions are allowed." : "New sessions are not allowed.",
  );
  await expect(row("Protocol")).toContainText(/^v\d+ /);
  await expect(row("ASR config")).toContainText(/asr_default v\d+/);
  await expect(row("Translation configs")).toContainText(/translation_default v\d+/);
  await expect(row("Translation configs")).toContainText(/translation_preserve v\d+/);
  await expect(row("TTS config")).toContainText(/tts_baseline v\d+/);
  await expect(row("Worker")).toContainText("Last heartbeat");
  await expect(status.locator("dt", { hasText: /^Worker$/ }).locator("xpath=following-sibling::dd[2]")).toHaveText("Healthy");
  await expect(row("Storage")).toContainText("readable and writable");
  await expect(row("Database")).toContainText("Connected.");
});

test("no outcome analysis appears on the Dashboard", async ({ page }) => {
  await openAdminPage(page, "/admin", "Dashboard");
  await expect(page.getByRole("region", { name: "Status" })).toBeVisible();
  const text = await page.getByRole("main").innerText();
  // Spec 42, 119, 154: no effect size, no comparison of translation conditions, no significance.
  expect(text).not.toMatch(/effect size|cohen|p[- ]value|significan|confidence interval|default vs|versus preservation|condition comparison|mean rating/i);
});

test("Refresh reloads the numbers", async ({ page }) => {
  await openAdminPage(page, "/admin", "Dashboard");
  const reload = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/dashboard");
  await page.getByRole("button", { name: "Refresh" }).click();
  expect((await reload).status()).toBe(200);
  await expect(page.getByText("Last updated just now")).toBeVisible();
});
