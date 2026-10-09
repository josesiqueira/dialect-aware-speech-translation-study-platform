// End-to-end test of the participant flow against the running app, with
// Chromium's test microphone (flags in playwright.config.ts).
//
// Every session started here is a TEST session: the browser signs in as admin
// through the API and enters through /?mode=test. No research session is created.
//
// The tests also write the screenshots docs/ui-current/participant-*.png, which
// are compared with the reference screenshots in docs/ui-reference.
import path from "node:path";
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { BASE_URL, ROOT, adminPassword } from "./support/env";

const SCREENSHOT_DIR = path.join(ROOT, "docs/ui-current");

/** The documented endpoints of docs/PARTICIPANT-API.md. The pages may call nothing else under /api/. */
const DOCUMENTED_ENDPOINTS: Array<[method: string, path: RegExp]> = [
  ["GET", /^\/api\/study\/info$/],
  ["POST", /^\/api\/study\/sessions$/],
  ["GET", /^\/api\/study\/session$/],
  ["POST", /^\/api\/study\/consent$/],
  ["POST", /^\/api\/study\/mic-check$/],
  ["POST", /^\/api\/study\/instructions$/],
  ["GET", /^\/api\/study\/next-task$/],
  ["POST", /^\/api\/study\/tasks\/[0-9a-f-]{36}\/start$/],
  ["POST", /^\/api\/study\/utterances$/],
  ["POST", /^\/api\/study\/utterances\/[0-9a-f-]{36}\/audio$/],
  ["DELETE", /^\/api\/study\/utterances\/[0-9a-f-]{36}\/audio$/],
  ["POST", /^\/api\/study\/utterances\/[0-9a-f-]{36}\/submit$/],
  ["POST", /^\/api\/study\/utterances\/[0-9a-f-]{36}\/skip$/],
  ["POST", /^\/api\/study\/questionnaires\/(background|post_recording)$/],
  ["POST", /^\/api\/study\/session\/complete$/],
  ["POST", /^\/api\/study\/session\/withdraw$/],
  ["POST", /^\/api\/study\/session\/locale$/],
  // The output review part after the questionnaires (docs/PARTICIPANT-API.md, "Output review").
  ["POST", /^\/api\/study\/english-check$/],
  ["POST", /^\/api\/study\/output-review\/start$/],
  ["POST", /^\/api\/study\/output-review\/skip$/],
  ["POST", /^\/api\/study\/output-review\/items\/[0-9a-f-]{36}\/answer$/],
  ["GET", /^\/api\/study\/output-review\/items\/[0-9a-f-]{36}\/audio\/(source|version1|version2)$/],
];

/** Field names that would carry AI output or a judgement of the participant's speech (spec 3.1, 83). */
const FORBIDDEN_KEY = /transcript|translat|synthes|\basr\b|\btts\b|model|dialect|classif|confidence/i;
/** Words that only an AI output panel would add to a task screen. */
const FORBIDDEN_TASK_TEXT = /transcript|transcription|translation|litteroin|käännös/i;

async function signInAsAdmin(context: BrowserContext): Promise<void> {
  const response = await context.request.post("/api/admin/login", {
    headers: { Origin: BASE_URL },
    data: { password: adminPassword() },
  });
  expect(response.status(), "admin sign-in").toBe(200);
}

function forbiddenKeysIn(value: unknown, trail = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => forbiddenKeysIn(entry, `${trail}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    ...(FORBIDDEN_KEY.test(key) ? [`${trail}.${key}`] : []),
    ...forbiddenKeysIn(entry, `${trail}.${key}`),
  ]);
}

/** Watches everything the page requests and receives. */
function watch(page: Page) {
  const requests: Request[] = [];
  const problems: string[] = [];
  const forbiddenKeys: string[] = [];
  const pending: Promise<void>[] = [];

  page.on("request", (request) => requests.push(request));
  page.on("pageerror", (error) => problems.push(`page error: ${String(error)}`));
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) problems.push(`CSP: ${message.text()}`);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/study/")) return;
    pending.push(
      response
        .json()
        .then((body: unknown) => {
          forbiddenKeys.push(...forbiddenKeysIn(body).map((key) => `${url.pathname}${key}`));
        })
        .catch(() => undefined),
    );
  });

  return {
    requests,
    api: (method: string, pattern: RegExp) =>
      requests.filter((request) => request.method() === method && pattern.test(new URL(request.url()).pathname)),
    async assertClean() {
      await Promise.all(pending);
      const origin = new URL(BASE_URL).origin;
      const undocumented: string[] = [];
      for (const request of requests) {
        const url = request.url();
        if (url.startsWith("blob:") || url.startsWith("data:")) continue;
        const parsed = new URL(url);
        if (parsed.origin !== origin) {
          undocumented.push(`${request.method()} ${url} (another origin)`);
        } else if (
          parsed.pathname.startsWith("/api/") &&
          !DOCUMENTED_ENDPOINTS.some(([method, pattern]) => method === request.method() && pattern.test(parsed.pathname))
        ) {
          undocumented.push(`${request.method()} ${parsed.pathname}`);
        }
        // No study state in any URL (spec 61). "_rsc" is the cache key Next.js adds to its own
        // page data requests: it is a hash of the router state and carries nothing of the study.
        if (parsed.pathname === "/study") {
          expect(
            [...parsed.searchParams.keys()].filter((name) => name !== "_rsc"),
            "query parameters of /study",
          ).toEqual([]);
        }
      }
      expect(undocumented, "requests outside the documented participant endpoints").toEqual([]);
      expect(forbiddenKeys, "AI output fields in participant API responses").toEqual([]);
      expect(problems, "page errors and CSP violations").toEqual([]);
    },
  };
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const recorderFrame = (page: Page) =>
  page.locator("[data-state]").filter({ has: page.getByTestId("recording-announcement") });

async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow at ${where}`).toBeLessThanOrEqual(0);
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `participant-${name}.png`), fullPage: false });
}

/**
 * The welcome page as a visitor without a session sees it. The study heading is
 * the title the participant API delivers. The begin button is offered only while
 * the study accepts new participants ("Allow new sessions" in the admin
 * Settings, off in the seed); otherwise the page says so plainly.
 */
async function expectWelcomePage(page: Page): Promise<void> {
  const info = (await (await page.request.get("/api/study/info")).json()) as Record<string, unknown> & {
    acceptingNewSessions: boolean;
  };
  await expect(heading(page)).toBeVisible();
  const title = (await heading(page).innerText()).trim();
  // The title in the chosen language: studyName, or one of studyNameByLocale.
  const titles = [info.studyName, ...Object.values((info.studyNameByLocale ?? {}) as Record<string, string>)];
  expect(titles, "the heading is a title from /api/study/info").toContain(title);
  const begin = page.getByRole("button", { name: /^(Aloita|Begin)$/ });
  const closed = page.getByText(
    /Tutkimukseen ei tällä hetkellä oteta uusia osallistujia\.|This study is not currently accepting new participants\./,
  );
  if (info.acceptingNewSessions) {
    await expect(begin).toBeVisible();
    await expect(closed).toHaveCount(0);
  } else {
    await expect(closed).toBeVisible();
    await expect(begin).toHaveCount(0);
  }
}

/** Opens the researcher test entry in English and begins. Ends on the information screen of /study. */
async function beginTestSession(page: Page): Promise<void> {
  await page.goto("/?mode=test");
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByTestId("participant-flow")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Test entry: the session that starts here is marked as a test")).toBeVisible();
  await page.getByRole("button", { name: "Begin" }).click();
  await page.waitForURL("**/study");
  expect(new URL(page.url()).search).toBe("");
  await expect(heading(page)).toHaveText("About the study");
  // The mode comes from the stored session, never from the URL.
  await expect(page.locator('[data-mode="TEST"]')).toBeVisible();
}

async function giveConsent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue to consent" }).click();
  const agree = page.getByRole("button", { name: "I agree and continue" });
  await expect(agree).toBeDisabled();
  for (const box of await page.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
  await page.getByRole("checkbox", { name: /I agree to take part in this study/ }).check();
  await page.getByRole("checkbox", { name: /my voice is recorded/ }).check();
  await expect(agree).toBeDisabled();
  await page.getByRole("checkbox", { name: /processed with external AI services/ }).check();
  await expect(agree).toBeDisabled();
  await page.getByRole("checkbox", { name: /I understand that at the end of the study I will be shown/ }).check();
  await expect(agree).toBeEnabled();
}

async function passMicCheck(page: Page): Promise<void> {
  await expect(heading(page)).toHaveText("Microphone check");
  const micCheck = page.getByTestId("mic-check");
  await expect(micCheck).toHaveAttribute("data-state", "idle");
  await micCheck.getByRole("button", { name: "Allow microphone" }).click();
  await micCheck.getByRole("button", { name: "Record test" }).click();
  await expect(micCheck).toHaveAttribute("data-state", "recording");
  await expect(micCheck).toHaveAttribute("data-state", "stopped", { timeout: 15_000 });
}

async function record(page: Page, startLabel: "Start recording" | "Record again" = "Start recording"): Promise<void> {
  await page.getByRole("button", { name: startLabel }).click();
  await expect(recorderFrame(page)).toHaveAttribute("data-state", "recording");
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(recorderFrame(page)).toHaveAttribute("data-state", "stopped");
}

async function expectTask(page: Page, number: number, total = 5): Promise<void> {
  await expect(page.getByText(`Task ${number} of ${total}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(number));
  await expect(page.getByRole("main")).not.toContainText(FORBIDDEN_TASK_TEXT);
  // The task category is never shown.
  await expect(page.getByRole("main")).not.toContainText(/controlled|semi.structured|free.speech task/i);
}

async function findSession(context: BrowserContext, participantCode: string) {
  const list = await context.request.get(`/api/admin/sessions?search=${encodeURIComponent(participantCode)}`);
  expect(list.status()).toBe(200);
  const { items } = (await list.json()) as { items: Array<{ id: string; participantCode: string }> };
  const match = items.find((item) => item.participantCode === participantCode);
  expect(match, `session ${participantCode} in the admin list`).toBeTruthy();
  const detail = await context.request.get(`/api/admin/sessions/${match!.id}`);
  expect(detail.status()).toBe(200);
  return (await detail.json()) as {
    session: { status: string; mode: string; locale: string | null };
    consent: { items: Array<{ itemId: string; accepted: boolean; required: boolean }> } | null;
    capture: { audioEnvironment: Record<string, unknown> | null };
    utterances: Array<{
      turnIndex: number;
      isFollowup: boolean;
      attemptCount: number;
      status: string;
      sourceMedia: { kind: string; container: string | null; captureQualityClass: string | null; sha256: string } | null;
    }>;
    questionnaires: {
      background: { answers: Array<{ itemKey: string; value: unknown }> } | null;
      post: { answers: Array<{ itemKey: string; value: unknown }> } | null;
    };
  };
}

async function expectCleanBrowser(page: Page, context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  expect(cookies.map((cookie) => cookie.name)).not.toContain("dts_participant");
  expect(cookies.map((cookie) => cookie.name)).not.toContain("dts_locale");
  const storage = await page.evaluate(() => ({ session: window.sessionStorage.length, local: window.localStorage.length }));
  expect(storage).toEqual({ session: 0, local: 0 });
}

test.describe("participant flow", () => {
  test.describe.configure({ timeout: 240_000 });
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the whole study as a TEST session: consent, mic check, five tasks, questionnaires, debrief, completion", async ({
    page,
    context,
  }) => {
    const watched = watch(page);

    // --- Welcome (spec 6.1) ---
    await page.goto("/");
    await expectWelcomePage(page);
    await expect(page.getByTestId("participant-flow")).toHaveAttribute("lang", "fi");
    await screenshot(page, "welcome-1440x900");

    // Without an admin session the test entry is refused with a plain message.
    await page.goto("/?mode=test");
    await page.getByRole("button", { name: "English" }).click();
    await page.getByRole("button", { name: "Begin" }).click();
    await expect(page.getByText("A test session can only be started by a signed-in researcher.")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");

    await signInAsAdmin(context);
    await beginTestSession(page);

    // --- Information and consent (spec 6.2) ---
    await page.reload();
    await expect(heading(page)).toHaveText("About the study");
    await giveConsent(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshot(page, "consent-1440x900");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "participant-consent-full-1440.png"), fullPage: true });
    // A reload before consent is stored: back at the information text, nothing is checked (spec 61).
    await page.reload();
    await expect(heading(page)).toHaveText("About the study");
    await giveConsent(page);
    await expect(page.getByRole("checkbox", { name: /reused in later research/ })).not.toBeChecked();
    await page.getByRole("button", { name: "I agree and continue" }).click();

    // --- Microphone check (spec 6.3) ---
    await expect(heading(page)).toHaveText("Microphone check");
    await expect(heading(page)).toBeFocused();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await page.reload();
    await passMicCheck(page);
    await screenshot(page, "mic-check-1440x900");
    await page.getByTestId("mic-check").getByRole("button", { name: "Continue" }).click();
    await expect(heading(page)).toHaveText("Instructions");
    // Only technical settings were sent: JSON, no audio.
    const [micCheckRequest] = watched.api("POST", /^\/api\/study\/mic-check$/);
    expect(micCheckRequest.headers()["content-type"]).toContain("application/json");
    expect(Object.keys(micCheckRequest.postDataJSON() as object).sort()).toEqual(["audioEnvironment", "browserInfo"]);
    expect((micCheckRequest.postData() ?? "").length).toBeLessThan(4000);

    // --- Instructions (spec 6.4) ---
    await page.reload();
    await expect(heading(page)).toHaveText("Instructions");
    await page.getByRole("button", { name: "Start", exact: true }).click();

    // --- Task 1: re-record, a failed upload, retry without recording again ---
    await expectTask(page, 1);
    await expect(page.getByText("Speaking task")).toBeVisible();
    await screenshot(page, "task-idle-1440x900");
    await record(page);
    await screenshot(page, "task-candidate-1440x900");
    await record(page, "Record again");
    const candidateUrl = await page.locator("audio source").getAttribute("src");
    expect(candidateUrl).toMatch(/^blob:/);

    let failNextUpload = true;
    await page.route("**/api/study/utterances/*/audio", async (route) => {
      if (route.request().method() === "POST" && failNextUpload) {
        failNextUpload = false;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "UPLOAD_FAILED", message: "The recording could not be saved." } }),
        });
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "Submit and continue" }).click();
    await expect(recorderFrame(page)).toHaveAttribute("data-state", "upload_failed");
    await expect(page.getByText("It is still here: you do not need to record again.")).toBeVisible();
    // The same recording is still there.
    expect(await page.locator("audio source").getAttribute("src")).toBe(candidateUrl);
    await page.getByRole("button", { name: "Try uploading again" }).click();
    await expectTask(page, 2);
    await page.unroute("**/api/study/utterances/*/audio");
    const submits = () => watched.api("POST", /\/submit$/);
    expect(submits()).toHaveLength(1);
    expect(submits()[0].postDataJSON()).toMatchObject({ attemptCount: 2 });
    expect(watched.api("POST", /\/audio$/)).toHaveLength(2);
    // The upload carries the facts the recorder produced, as declared metadata.
    const uploadBody = (watched.api("POST", /\/audio$/)[1].postDataBuffer() ?? Buffer.alloc(0)).toString("latin1");
    for (const field of ["captureMethod", "declaredBitDepth", "declaredDurationMs", "inputChannelCount", "clippedSampleCount", "peak", "stoppedBy"]) {
      expect(uploadBody, `metadata field ${field}`).toContain(`"${field}"`);
    }

    // --- Task 2, then a reload in the middle of the tasks ---
    const secondTitle = await heading(page).innerText();
    await record(page);
    await page.getByRole("button", { name: "Submit and continue" }).click();
    await expectTask(page, 3);
    await expect(heading(page)).not.toHaveText(secondTitle);
    await page.reload();
    await expectTask(page, 3);
    await expect(heading(page)).toHaveText("Where you grew up");

    // --- Task 3: main prompt, then the predefined follow-up turn ---
    await expect(page.getByTestId("task-step")).toHaveAttribute("data-turn-index", "0");
    await record(page);
    await page.getByRole("button", { name: "Submit and continue" }).click();
    await expect(page.getByTestId("task-step")).toHaveAttribute("data-turn-index", "1");
    await expectTask(page, 3);
    // Focus moves to the heading of the new screen, so it is announced (spec 99).
    await expect(heading(page)).toBeFocused();
    await expect(page.getByText("Follow-up question", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("task-current-prompt")).toHaveText(
      "Tell us about a typical situation you remember from there.",
    );
    await expect(page.getByTestId("task-original-prompt")).toContainText("Tell us about the place where you grew up");
    // A required follow-up cannot be skipped.
    await expect(page.getByRole("button", { name: "Skip this question" })).toHaveCount(0);
    // A fresh turn: no recording carries over.
    await expect(recorderFrame(page)).toHaveAttribute("data-state", "idle");
    await record(page);
    await page.getByRole("button", { name: "Submit and continue" }).click();

    // --- Task 4: the submit fails after the upload, the participant records again ---
    await expectTask(page, 4);
    await record(page);
    let failNextSubmit = true;
    await page.route("**/api/study/utterances/*/submit", async (route) => {
      if (failNextSubmit) {
        failNextSubmit = false;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "Submit and continue" }).click();
    await expect(recorderFrame(page)).toHaveAttribute("data-state", "upload_failed");
    const deletesBefore = watched.api("DELETE", /\/audio$/).length;
    await record(page, "Record again");
    // The uploaded candidate of the rejected attempt is removed from the server (spec 10).
    await expect.poll(() => watched.api("DELETE", /\/audio$/).length).toBe(deletesBefore + 1);
    await page.getByRole("button", { name: "Submit and continue" }).click();
    await expectTask(page, 5);
    await page.unroute("**/api/study/utterances/*/submit");
    expect(submits().at(-1)!.postDataJSON()).toMatchObject({ attemptCount: 2 });

    // --- Task 5: free speech with the privacy reminder ---
    await expect(page.getByText("or other unnecessary identifying personal information.")).toBeVisible();
    await record(page);
    await page.getByRole("button", { name: "Submit and continue" }).click();

    // --- Background questionnaire (spec 11), with a reload ---
    await expect(heading(page)).toHaveText("Background questionnaire");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await page.reload();
    await expect(heading(page)).toHaveText("Background questionnaire");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Please check the marked questions (5).")).toBeVisible();
    await page.getByRole("radio", { name: "25 to 34" }).check();
    await page.getByRole("textbox", { name: /municipality or region did you mainly grow up/ }).fill("Kuopio");
    await page.getByRole("textbox", { name: /In which region do you live now/ }).fill("Pirkanmaa");
    await page.getByRole("textbox", { name: /first language/ }).fill("Finnish");
    await page.getByRole("radio", { name: "Well", exact: true }).check();
    // The error of an item goes away when it is answered.
    await expect(page.getByRole("textbox", { name: /first language/ })).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Please answer this question.")).toHaveCount(0);
    await page.getByRole("heading", { level: 1 }).focus();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await screenshot(page, "questionnaire-1440x900");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "participant-questionnaire-full-1440.png"), fullPage: true });
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // --- Post-recording questionnaire (spec 12) ---
    await expect(heading(page)).toHaveText("Post-recording questionnaire");
    for (const key of ["naturalness", "changed_speech", "more_standard", "emphasized_regional", "comfort", "task_felt_unnatural"]) {
      await page.locator(`[data-item-key="${key}"] label`).filter({ hasText: /^4$/ }).click();
    }
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // --- Output review: this environment has no AI model, so nothing becomes ready
    // and the participant leaves the part with "Skip this part" (tested further below).
    await expect(heading(page)).toHaveText("Preparing your recordings", { timeout: 20_000 });
    await page.getByRole("button", { name: "Skip this part" }).click();

    // --- Debrief (spec 13) ---
    await expect(heading(page)).toHaveText("More about the study");
    const participantCode = (await page.getByTestId("participant-code").innerText()).trim();
    expect(participantCode).toMatch(/^P-[2-9A-Z]{6}$/);
    await expect(page.getByText("This code identifies your contribution.")).toBeVisible();
    await screenshot(page, "debrief-1440x900");
    await page.getByRole("button", { name: "Finish" }).click();

    // --- Completion ---
    await expect(heading(page)).toHaveText("Thank you for taking part");
    await expect(page.getByRole("button", { name: "End participation" })).toHaveCount(0);
    await screenshot(page, "completed-1440x900");
    await expectCleanBrowser(page, context);
    await watched.assertClean();

    // --- What the server stored ---
    const detail = await findSession(context, participantCode);
    expect(detail.session).toMatchObject({ status: "completed", mode: "test", locale: "en" });
    expect(detail.utterances).toHaveLength(6);
    for (const utterance of detail.utterances) {
      expect(utterance.status).toBe("submitted");
      expect(utterance.sourceMedia).toMatchObject({
        kind: "source_audio",
        container: "wav",
        captureQualityClass: "lossless_pcm",
      });
      expect(utterance.sourceMedia!.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(detail.utterances.filter((utterance) => utterance.isFollowup)).toHaveLength(1);
    expect(detail.utterances.map((utterance) => utterance.attemptCount).sort()).toEqual([1, 1, 1, 1, 2, 2]);
    expect(detail.consent).not.toBeNull();
    expect(Object.fromEntries(detail.consent!.items.map((item) => [item.itemId, item.accepted]))).toEqual({
      participation: true,
      voice_recording: true,
      external_ai_processing: true,
      future_research_reuse: false,
      output_review: true,
    });
    expect(detail.capture.audioEnvironment).toMatchObject({ captureMethod: "audio_worklet_pcm" });
    const answered = (answers: Array<{ itemKey: string; value: unknown }>) =>
      Object.fromEntries(answers.filter((answer) => answer.value !== null).map((answer) => [answer.itemKey, answer.value]));
    expect(answered(detail.questionnaires.background!.answers)).toEqual({
      age_range: "25_34",
      region_grew_up: "Kuopio",
      current_region: "Pirkanmaa",
      first_languages: "Finnish",
      english_reading: 4,
    });
    expect(answered(detail.questionnaires.post!.answers)).toEqual({
      naturalness: 4,
      changed_speech: 4,
      more_standard: 4,
      emphasized_regional: 4,
      comfort: 4,
      task_felt_unnatural: 4,
    });

    // --- The next person: a clean welcome page, nothing of the previous participant ---
    await page.goto("/study");
    await page.waitForURL(new URL("/", BASE_URL).toString());
    await expectWelcomePage(page);
    await expect(page.getByTestId("participant-flow")).toHaveAttribute("lang", "fi");
    await expect(page.getByRole("button", { name: /Jatka tutkimusta|Continue the study/ })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(participantCode);
    await expect(page.locator("audio")).toHaveCount(0);
    await expectCleanBrowser(page, context);
  });

  test("ending participation at a task: nothing unfinished is kept, the debrief is shown, the next visit is clean", async ({
    page,
    context,
  }) => {
    const watched = watch(page);
    await signInAsAdmin(context);
    await beginTestSession(page);
    await expect(page.getByRole("button", { name: "End participation" })).toBeVisible();
    await giveConsent(page);
    await page.getByRole("button", { name: "I agree and continue" }).click();
    await passMicCheck(page);
    await page.getByTestId("mic-check").getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expectTask(page, 1);

    // An uploaded candidate exists on the server: the upload arrives, the submit does not.
    await record(page);
    await page.route("**/api/study/utterances/*/submit", (route) => route.abort("failed"));
    await page.getByRole("button", { name: "Submit and continue" }).click();
    await expect(recorderFrame(page)).toHaveAttribute("data-state", "upload_failed");
    const uploadsBefore = watched.api("POST", /\/audio$/).length;
    expect(uploadsBefore).toBe(1);

    // A new recording is running when the participant ends participation.
    await page.getByRole("button", { name: "Record again" }).click();
    await expect(recorderFrame(page)).toHaveAttribute("data-state", "recording");

    await page.getByRole("button", { name: "End participation" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "End your participation?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Continue the study" }).click();
    await expect(dialog).toBeHidden();
    await expect(recorderFrame(page)).toHaveAttribute("data-state", "recording");

    await page.getByRole("button", { name: "End participation" }).click();
    await dialog.getByRole("button", { name: "End participation" }).click();

    await expect(heading(page)).toHaveText("Your participation has ended");
    await expect(page.getByTestId("withdrawn-step")).toContainText("Thank you for taking part.");
    await expect(page.getByTestId("withdrawn-step")).toContainText("Contact");
    const participantCode = (await page.getByTestId("participant-code").innerText()).trim();
    // The unfinished recording was not uploaded, and no recorder is left on the page.
    expect(watched.api("POST", /\/audio$/)).toHaveLength(uploadsBefore);
    await expect(page.locator("audio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "End participation" })).toHaveCount(0);
    await expectCleanBrowser(page, context);
    await watched.assertClean();

    const detail = await findSession(context, participantCode);
    expect(detail.session).toMatchObject({ status: "withdrawn", mode: "test" });
    // No candidate is left: no utterance of the session has a recording.
    expect(detail.utterances.filter((utterance) => utterance.sourceMedia !== null)).toEqual([]);
    expect(detail.utterances.filter((utterance) => utterance.status === "submitted")).toEqual([]);

    await page.getByRole("button", { name: "Back to the first page" }).click();
    await page.waitForURL(new URL("/", BASE_URL).toString());
    await expectWelcomePage(page);
    await expect(page.locator("body")).not.toContainText(participantCode);
    await expectCleanBrowser(page, context);
  });
});

test.describe("participant flow: failures", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a network failure is retried in place, and an ended session leads calmly back to the welcome page", async ({
    page,
    context,
  }) => {
    const watched = watch(page);
    await signInAsAdmin(context);
    await beginTestSession(page);
    await giveConsent(page);

    // The request does not reach the server: a plain message, the choices are kept, the same button retries.
    let failNext = true;
    await page.route("**/api/study/consent", async (route) => {
      if (failNext) {
        failNext = false;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "I agree and continue" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      /The server could not be reached\. Check the internet connection and try again\./,
    );
    await expect(page.getByRole("checkbox", { name: /my voice is recorded/ })).toBeChecked();
    await expect(page.locator("body")).not.toContainText(/TypeError|Failed to fetch|at .*\.tsx?:\d+/);
    await page.getByRole("button", { name: "I agree and continue" }).click();
    await expect(heading(page)).toHaveText("Microphone check");

    // The session ends on the server side (here: the cookie is gone, as after the token expired).
    await context.clearCookies({ name: "dts_participant" });
    await passMicCheck(page);
    await page.getByTestId("mic-check").getByRole("button", { name: "Continue" }).click();
    await expect(heading(page)).toHaveText("The session has ended");
    await expect(page.getByText("Your session has ended or expired.")).toBeVisible();
    await expect(page.getByRole("button", { name: "End participation" })).toHaveCount(0);
    await expectCleanBrowser(page, context);
    await page.getByRole("button", { name: "Back to the first page" }).click();
    await page.waitForURL(new URL("/", BASE_URL).toString());
    await expectWelcomePage(page);
    await watched.assertClean();
  });
});

test.describe("participant flow on a phone", () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ viewport: { width: 390, height: 844 } });

  test("390 by 844: welcome through the first task without horizontal overflow", async ({ page, context }) => {
    const watched = watch(page);
    await page.goto("/");
    await expect(heading(page)).toBeVisible();
    await expectNoHorizontalOverflow(page, "welcome");
    await screenshot(page, "welcome-390x844");

    await signInAsAdmin(context);
    await beginTestSession(page);
    await expectNoHorizontalOverflow(page, "information");
    await giveConsent(page);
    await expectNoHorizontalOverflow(page, "consent");
    await page.getByRole("button", { name: "I agree and continue" }).click();
    await passMicCheck(page);
    await expectNoHorizontalOverflow(page, "microphone check");
    await page.getByTestId("mic-check").getByRole("button", { name: "Continue" }).click();
    await expect(heading(page)).toHaveText("Instructions");
    await expectNoHorizontalOverflow(page, "instructions");
    await page.getByRole("button", { name: "Start", exact: true }).click();

    await expectTask(page, 1);
    await expectNoHorizontalOverflow(page, "task, before recording");
    await screenshot(page, "task-390x844");
    await record(page);
    await expectNoHorizontalOverflow(page, "task, with a recording");
    await page.getByRole("button", { name: "Submit and continue" }).click();
    await expectTask(page, 2);
    await expectNoHorizontalOverflow(page, "second task");

    // The Finnish interface on the same task: the choice survives a reload, and the longer words still fit.
    await page.getByRole("button", { name: "Suomi" }).click();
    await expect(page.getByTestId("participant-flow")).toHaveAttribute("lang", "fi");
    await expect(page.getByText("Tehtävä 2/5", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Tehtävä 2/5", { exact: true })).toBeVisible();
    await expect(page.getByText("Puhetehtävä")).toBeVisible();
    await page.getByRole("button", { name: "Aloita äänitys" }).click();
    await expect(recorderFrame(page)).toHaveAttribute("data-state", "recording");
    await page.waitForTimeout(1300);
    await page.getByRole("button", { name: "Lopeta", exact: true }).click();
    await expect(recorderFrame(page)).toHaveAttribute("data-state", "stopped");
    await expect(page.getByRole("button", { name: "Lähetä ja jatka" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "task in Finnish, with a recording");
    await screenshot(page, "task-fi-390x844");

    // Leave no running session behind.
    await page.getByRole("button", { name: "Lopeta osallistuminen" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Lopetetaanko osallistuminen?" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "end participation dialog");
    await page.getByRole("dialog").getByRole("button", { name: "Lopeta osallistuminen" }).click();
    await expect(heading(page)).toHaveText("Osallistumisesi on päättynyt");
    await expectNoHorizontalOverflow(page, "withdrawal screen");
    await watched.assertClean();
  });
});

/** A short 16-bit mono PCM WAV tone, as an uploaded recording. */
function toneWav(durationMs = 1500, sampleRate = 16000): Buffer {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

type ApiState = {
  step: string;
  participantCode: string;
  task?: { presentationId: string; status: string; turn: { turnIndex: number; isOptional: boolean } };
  questionnaire?: { key: string; items: Array<{ itemKey: string; type: string; required: boolean; config: Record<string, unknown> }> };
};

/** Valid answers for any questionnaire, built from its items. */
function answersFor(questionnaire: NonNullable<ApiState["questionnaire"]>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const item of questionnaire.items) {
    if (!item.required) continue;
    const options = (item.config.options as Array<{ value: string }> | undefined) ?? [];
    if (item.type === "likert") answers[item.itemKey] = 3;
    else if (item.type === "single_choice") answers[item.itemKey] = options[0]?.value;
    else if (item.type === "multi_choice") answers[item.itemKey] = options.slice(0, 1).map((option) => option.value);
    else if (item.type === "integer") answers[item.itemKey] = (item.config.min as number | undefined) ?? 1;
    else if (item.type === "boolean") answers[item.itemKey] = true;
    else answers[item.itemKey] = "Kuopio";
  }
  return answers;
}

test.describe("participant flow: output review part", () => {
  test.describe.configure({ timeout: 240_000 });
  test.use({ viewport: { width: 1440, height: 900 } });

  test("with the review statement accepted: the preparing screen, skipping, and what the admin sees", async ({
    page,
    context,
  }) => {
    await signInAsAdmin(context);
    await beginTestSession(page);
    // giveConsent ticks the required review statement as well.
    await giveConsent(page);
    await page.getByRole("button", { name: "I agree and continue" }).click();
    await expect(heading(page)).toHaveText("Microphone check");

    // The speaking tasks through the participant API (the browser task flow is
    // covered by the test above). The request context shares the session cookie.
    const api = page.request;
    const post = async (pathname: string, data?: unknown) => {
      const response = await api.post(pathname, { headers: { Origin: BASE_URL }, ...(data === undefined ? {} : { data }) });
      expect(response.status(), pathname).toBe(200);
      return ((await response.json()) as { state: ApiState }).state;
    };
    await post("/api/study/mic-check", { audioEnvironment: {} });
    let state = await post("/api/study/instructions");
    for (let guard = 0; state.step === "tasks" && guard < 30; guard += 1) {
      const task = state.task!;
      if (task.status === "pending") state = await post(`/api/study/tasks/${task.presentationId}/start`);
      const created = await api.post("/api/study/utterances", {
        headers: { Origin: BASE_URL },
        data: { presentationId: task.presentationId, turnIndex: state.task!.turn.turnIndex },
      });
      const { utteranceId } = (await created.json()) as { utteranceId: string };
      const upload = await api.post(`/api/study/utterances/${utteranceId}/audio`, {
        headers: { Origin: BASE_URL },
        multipart: { audio: { name: "recording.wav", mimeType: "audio/wav", buffer: toneWav() } },
      });
      expect(upload.status(), "upload").toBe(200);
      const { mediaAssetId } = (await upload.json()) as { mediaAssetId: string };
      state = await post(`/api/study/utterances/${utteranceId}/submit`, { mediaAssetId, attemptCount: 1 });
    }
    for (const key of ["background", "post_recording"]) {
      expect(state.step).toBe(key);
      state = await post(`/api/study/questionnaires/${key}`, { answers: answersFor(state.questionnaire!) });
    }
    // The English vocabulary test is off by default: the review comes right after the questionnaires.
    expect(state.step).toBe("output_review");

    // The review waits for the processing of the recordings. In this environment
    // no model is configured, so nothing becomes ready; the participant can skip.
    const watcher = watch(page);
    await page.reload();
    await expect(heading(page)).toHaveText("Preparing your recordings", { timeout: 20_000 });
    await expect(page.getByRole("main")).not.toContainText(FORBIDDEN_TASK_TEXT);
    await page.getByRole("button", { name: "Skip this part" }).click();
    await expect(heading(page)).toHaveText("More about the study");
    await expect(page.getByText(/a limitation of the systems, not of how you speak/)).toBeVisible();
    await watcher.assertClean();

    const list = await context.request.get(`/api/admin/sessions?search=${encodeURIComponent(state.participantCode)}`);
    const { items } = (await list.json()) as { items: Array<{ id: string; participantCode: string }> };
    const id = items.find((item) => item.participantCode === state.participantCode)!.id;
    const detail = (await (await context.request.get(`/api/admin/sessions/${id}`)).json()) as {
      englishCheck: { score: number; testVersion: string } | null;
      outputReview: { status: string; skippedAtStep: string | null } | null;
      consent: { items: Array<{ itemId: string; accepted: boolean }> } | null;
    };
    expect(detail.consent!.items.find((item) => item.itemId === "output_review")?.accepted).toBe(true);
    expect(detail.englishCheck).toBeNull();
    expect(detail.outputReview).toMatchObject({ status: "skipped", skippedAtStep: "output_review:preparing" });
  });
});
