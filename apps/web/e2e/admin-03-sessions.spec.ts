// Sessions and Session Detail (spec 43 to 45, 157.3 to 157.5, 157.16 to 157.18, 158).
import { expect, test, type Locator, type Page } from "@playwright/test";
import { downloadBytes, openAdminPage, readZip, sampleSessions, type SessionListItem } from "./support/admin";

let samples: SessionListItem[];

test.beforeEach(async ({ page }) => {
  samples = await sampleSessions(page.context().request);
});

function listRow(page: Page, code: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${code} `) });
}

async function openSession(page: Page, session: SessionListItem): Promise<void> {
  await openAdminPage(page, "/admin/sessions", "Sessions");
  await listRow(page, session.participantCode).click();
  await expect(page.getByRole("heading", { level: 2, name: session.participantCode })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`session=${session.id}`));
}

test("the list shows every mode by default, with an unmistakable TEST badge, filters, search and pagination", async ({ page }) => {
  await openAdminPage(page, "/admin/sessions", "Sessions");
  const filters = page.getByRole("search", { name: "Session filters" });
  const mode = filters.getByLabel("Filter by mode");

  // The default of this page is "All modes", so TEST sessions are listed and each one carries the badge.
  await expect(mode).toHaveValue("");
  await expect(mode.locator("option:checked")).toHaveText("All modes");
  for (const session of samples) {
    const row = listRow(page, session.participantCode);
    await expect(row).toBeVisible();
    await expect(row.getByText("TEST", { exact: true })).toBeVisible();
    await expect(row).toContainText("Completed");
    await expect(row).toContainText("6 utterances");
  }

  // Research only: none of the sample sessions.
  await mode.selectOption({ label: "Research" });
  await expect(page.getByText("No sessions match the selected filters.")).toBeVisible();
  await expect(page).toHaveURL(/mode=research/);
  for (const session of samples) await expect(listRow(page, session.participantCode)).toHaveCount(0);

  // Test only: the sample sessions again.
  await mode.selectOption({ label: "Test" });
  for (const session of samples) await expect(listRow(page, session.participantCode)).toBeVisible();

  // Review state: only the first sample session has every B and C verified.
  await filters.getByLabel("Filter by review state").selectOption({ label: "Review complete" });
  await expect(listRow(page, samples[0]!.participantCode)).toBeVisible();
  await expect(listRow(page, samples[2]!.participantCode)).toHaveCount(0);
  await filters.getByLabel("Filter by review state").selectOption({ label: "Any review state" });

  // Search by participant code.
  await filters.getByRole("searchbox", { name: "Search by participant code or session id" }).fill(samples[1]!.participantCode);
  await expect(listRow(page, samples[1]!.participantCode)).toBeVisible();
  await expect(listRow(page, samples[0]!.participantCode)).toHaveCount(0);
  await expect(listRow(page, samples[2]!.participantCode)).toHaveCount(0);

  const pagination = page.getByRole("navigation", { name: "Pagination" });
  await expect(pagination).toContainText("1 session");
  await expect(pagination).toContainText("Page 1 of 1");
  await expect(pagination.getByRole("button", { name: "Previous" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Next" })).toBeDisabled();
});

test("Session Detail shows header, consent, exact prompts, playable source audio, transcripts, translations with provenance and questionnaires", async ({
  page,
}) => {
  const session = samples[0]!;

  // Every request to the media streaming route (not the download route).
  const mediaResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => {
    if (/\/api\/admin\/media\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname)) {
      mediaResponses.push({ url: response.url(), status: response.status() });
    }
  });

  await openSession(page, session);
  const main = page.getByRole("main");

  // Header.
  await expect(main.getByText("TEST", { exact: true }).first()).toBeVisible();
  await expect(main.locator("dt", { hasText: "Protocol:" }).locator("xpath=following-sibling::dd[1]")).toHaveText(/^v1 /);
  await expect(main.getByRole("list", { name: "Completeness checks" })).toContainText("Source audio");

  // 1. Consent summary with the exact item texts.
  const consent = main.getByRole("region", { name: "1. Consent summary" });
  await expect(consent).toContainText(/Consent version v\d+/);
  await expect(consent).toContainText("I agree that my voice is recorded during the study.");
  // The sample sessions accept every item except the optional output review.
  await expect(consent.getByRole("listitem")).toHaveCount(5);
  await expect(consent.getByRole("listitem").filter({ hasText: "Not accepted" })).toHaveCount(1);

  // 3. Task sequence with the stored prompt text.
  const tasks = main.getByRole("region", { name: "3. Task sequence" });
  await expect(tasks.getByRole("row")).toHaveCount(6);
  const firstTask = tasks.getByRole("row").nth(1);
  await firstTask.getByText("Prompt, context and instructions").click();
  await expect(firstTask).toContainText(/Imagine|Tell us|Speak naturally/);

  // 4. Utterances.
  const utterances = main.getByRole("region", { name: "4. Utterances" });
  await expect(utterances.getByRole("article")).toHaveCount(6);
  const first = utterances.getByRole("article", { name: "Utterance U-01" });
  await expect(first.getByText("Exact prompt shown")).toBeVisible();
  await expect(first.getByRole("blockquote")).toContainText(/\S+ \S+ \S+/);

  // Source audio: nothing is fetched before play is pressed.
  const audio = first.locator("audio").first();
  await expect(audio).toHaveAttribute("preload", "none");
  expect(mediaResponses, "media requests before play").toEqual([]);
  expect(await audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBe(0);
  await audio.evaluate((element: HTMLAudioElement) => element.play());
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState), { message: "audio metadata loaded" })
    .toBeGreaterThanOrEqual(1);
  const duration = await audio.evaluate((element: HTMLAudioElement) => element.duration);
  expect(duration).toBeGreaterThan(1);
  expect(mediaResponses.length).toBeGreaterThan(0);
  for (const response of mediaResponses) expect([200, 206], response.url).toContain(response.status);
  await audio.evaluate((element: HTMLAudioElement) => element.pause());

  // Transcripts A, B and C.
  await expect(first.getByText("Immutable model output")).toBeVisible();
  await expect(first).toContainText("[mock-transkriptio");
  await expect(first).toContainText("[sample B transcript 1]");
  await expect(first).toContainText("[sample C transcript 1]");
  await expect(first).toContainText(/Human dialect transcript.?Verified/);

  // Translation matrix, grouped by batch.
  const matrix = first.getByRole("table", { name: `Translations of batch sample-${session.participantCode} by transcript and condition` });
  await expect(matrix.getByRole("columnheader", { name: "default" })).toBeVisible();
  await expect(matrix.getByRole("columnheader", { name: "preservation" })).toBeVisible();
  for (const transcript of ["A", "B", "C"]) {
    await expect(matrix.getByRole("rowheader", { name: transcript, exact: true })).toBeVisible();
  }
  const cell = matrix.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "B", exact: true }) }).getByRole("cell").first();
  await expect(cell).toContainText("[mock translation");

  // Provenance (spec 158): model, prompt version, config version, batch, time and app version.
  const provenance = cell.locator("details");
  await provenance.locator("summary").click();
  const value = (term: string, index = 0) =>
    provenance.locator("dt", { hasText: new RegExp(`^${term}$`) }).nth(index).locator("xpath=following-sibling::dd[1]");
  await expect(value("Condition")).toContainText("default");
  await expect(value("Source transcript")).toContainText(/B revision \d+/);
  await expect(value("Batch")).toContainText(`sample-${session.participantCode}`);
  await expect(value("Model")).toContainText("mock / mock-translation");
  await expect(value("Prompt version")).toContainText(/mock_translation_default v\d+/);
  await expect(value("Config version")).toContainText(/mock_translation_default v\d+/);
  await expect(value("Generated")).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/);
  await expect(value("App version")).toContainText(/\S+/);
  await expect(provenance.getByRole("button", { name: "Copy model run id" }).first()).toBeVisible();
  // The TTS part: voice, model, config version, time, app version.
  await expect(value("Voice")).toContainText("mock-voice");
  await expect(value("Model", 1)).toContainText("mock / mock-tts");
  await expect(value("Config version", 1)).toContainText(/mock_tts v\d+/);
  await expect(value("Generated", 1)).toContainText(/\d{4}-\d{2}-\d{2}/);
  await expect(value("App version", 1)).toContainText(/\S+/);
  await expect(value("Text spoken")).toContainText("identical to the translation");

  // 5 and 6. Questionnaire answers.
  const background = main.getByRole("region", { name: "5. Background questionnaire" });
  await expect(background).toContainText("In which municipality or region did you mainly grow up?");
  await expect(background.locator("dd").first()).toContainText(/\S/);
  const post = main.getByRole("region", { name: "6. Post-recording questionnaire" });
  await expect(post.locator("dd").first()).toContainText(/\S/);

  // 8. Processing history exists.
  await expect(main.getByRole("region", { name: "8. Processing history" })).toBeVisible();
});

test("flagging a session with notes shows the Flagged badge in the list, and the flag can be cleared", async ({ page }) => {
  const session = samples[1]!;
  await openSession(page, session);
  const row = listRow(page, session.participantCode);
  await expect(row).not.toContainText("Flagged");

  const flag = page.getByRole("checkbox", { name: "Flag this session for review" });
  const flagSaved = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/admin/sessions/${session.id}/flag`),
  );
  await flag.check();
  expect((await flagSaved).status()).toBe(200);

  const notesSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/api/admin/sessions/${session.id}/flag`) &&
      (response.request().postData() ?? "").includes("e2e: check the second task"),
  );
  await page.getByPlaceholder("What should be checked in this session?").fill("e2e: check the second task");
  expect((await notesSaved).status()).toBe(200);

  await page.reload();
  await expect(listRow(page, session.participantCode)).toContainText("Flagged");
  await expect(page.getByRole("checkbox", { name: "Flag this session for review" })).toBeChecked();
  await expect(page.getByPlaceholder("What should be checked in this session?")).toHaveValue("e2e: check the second task");

  // The flag filter finds it.
  await page.getByRole("search", { name: "Session filters" }).getByLabel("Filter by flag").selectOption({ label: "Flagged" });
  await expect(listRow(page, session.participantCode)).toBeVisible();
  await expect(listRow(page, samples[0]!.participantCode)).toHaveCount(0);
  await page.getByRole("search", { name: "Session filters" }).getByLabel("Filter by flag").selectOption({ label: "Flagged or not" });

  // Clear the flag again, so that later specs see an unflagged session.
  const cleared = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/admin/sessions/${session.id}/flag`),
  );
  await page.getByRole("checkbox", { name: "Flag this session for review" }).uncheck();
  expect((await cleared).status()).toBe(200);
  await expect(listRow(page, session.participantCode)).not.toContainText("Flagged");
});

test("an utterance is excluded with a reason and included again", async ({ page }) => {
  const session = samples[1]!;
  await openSession(page, session);
  const utterance = page.getByRole("article", { name: "Utterance U-02" });

  await utterance.getByRole("button", { name: "Exclude utterance from analysis" }).click();
  const dialog = page.getByRole("dialog", { name: "Exclude utterance U-02 from analysis?" });
  await expect(dialog).toBeVisible();

  // A reason is required: the browser refuses an empty field, the page refuses spaces only.
  const reason = dialog.getByRole("textbox", { name: /^Reason/ });
  await dialog.getByRole("button", { name: "Exclude utterance" }).click();
  await expect(dialog).toBeVisible();
  expect(await reason.evaluate((element: HTMLTextAreaElement) => element.validity.valueMissing)).toBe(true);
  await reason.fill("   ");
  await dialog.getByRole("button", { name: "Exclude utterance" }).click();
  await expect(dialog.getByText("A reason is required.")).toBeVisible();

  await reason.fill("e2e: background noise");
  await dialog.getByRole("button", { name: "Exclude utterance" }).click();
  await expect(dialog).toBeHidden();
  await expect(utterance).toContainText("Excluded from analysis: e2e: background noise");
  await expect(utterance.getByRole("button", { name: "Include in analysis again" })).toBeVisible();
  // Nothing was deleted: the recording is still offered.
  await expect(utterance.getByRole("link", { name: "Download WAV" })).toBeVisible();

  await utterance.getByRole("button", { name: "Include in analysis again" }).click();
  await expect(utterance.getByRole("button", { name: "Exclude utterance from analysis" })).toBeVisible();
  await expect(utterance).not.toContainText("Excluded from analysis");

  // Both actions are in the audit history of the session.
  await page.getByRole("button", { name: "View audit history" }).click();
  const audit = page.getByRole("table", { name: "Audit history of this session" });
  await expect(audit.getByRole("rowheader").filter({ hasText: /exclude/i }).first()).toBeVisible();
  await expect(audit.getByRole("rowheader").filter({ hasText: /include/i }).first()).toBeVisible();
});

test("the source WAV downloads with a pseudonymous file name and RIFF bytes", async ({ page }) => {
  const session = samples[0]!;
  await openSession(page, session);
  const utterance = page.getByRole("article", { name: "Utterance U-03" });

  const started = page.waitForEvent("download");
  await utterance.getByRole("link", { name: "Download WAV" }).click();
  const download = await started;
  expect(download.suggestedFilename()).toBe(`${session.participantCode}_U-03_source.wav`);
  expect(download.suggestedFilename()).toMatch(/^P-[A-Z0-9]+_U-\d{2}_source\.wav$/);

  const bytes = await downloadBytes(download);
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(bytes.subarray(8, 12).toString("latin1")).toBe("WAVE");
  expect(bytes.length).toBeGreaterThan(44);
});

test("the session package downloads as a ZIP with MANIFEST.json", async ({ page }) => {
  const session = samples[0]!;
  await openSession(page, session);

  const started = page.waitForEvent("download");
  // Without this the rejected wait would be reported as a second, unrelated error.
  started.catch(() => undefined);
  await page.getByRole("button", { name: "Download session package" }).click();
  await expect(page.getByText(/The download of .* has started\./)).toBeVisible();
  const download = await started;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  const bytes = await downloadBytes(download);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  const zip = readZip(bytes);
  expect([...zip.keys()]).toContain("MANIFEST.json");
  const manifest = JSON.parse(zip.get("MANIFEST.json")!.data().toString("utf8")) as Record<string, unknown>;
  expect(Object.keys(manifest).length).toBeGreaterThan(0);
  // The package holds the recordings of this session under the pseudonymous names.
  const sourceFiles = [...zip.keys()].filter((name) => name.startsWith("source_audio/"));
  expect(sourceFiles.length).toBe(6);
  for (const name of sourceFiles) expect(name).toContain(session.participantCode);
});
