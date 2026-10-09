// Browser tests of Demo Mode (/demo) and of the admin pipeline test on the AI
// Pipeline page, against the running app, with Chromium's test microphone.
//
// The development database has active configurations for the `openai` provider
// and this machine has no API key, so the demo runs with the mock provider
// option (admin only, labelled on the page as not real model output). The
// tests do not create, change or activate any model configuration through the
// AI Pipeline page.
//
// They also write docs/ui-current/demo.png, demo-mobile.png and pipeline-test.png.
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { BASE_URL, ROOT, adminPassword } from "./support/env";

const SCREENSHOT_DIR = path.join(ROOT, "docs/ui-current");

async function signInAsAdmin(context: BrowserContext): Promise<void> {
  const response = await context.request.post("/api/admin/login", {
    headers: { Origin: BASE_URL },
    data: { password: adminPassword() },
  });
  expect(response.status(), "admin sign-in").toBe(200);
}

/** Collects console errors and Content Security Policy violations of the page. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(String(error)));
  void page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`Content Security Policy violation: ${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });
  return problems;
}

/** "loaded" when the browser can read the audio behind the element's source. */
function audioLoads(page: Page, selector: string, index: number): Promise<string> {
  return page.evaluate(
    ([target, position]) =>
      new Promise<string>((resolve) => {
        const element = document.querySelectorAll<HTMLAudioElement>(target as string)[position as number];
        const source = element?.querySelector("source")?.src ?? element?.src;
        if (!source) {
          resolve("no source");
          return;
        }
        const probe = new Audio();
        probe.preload = "metadata";
        probe.onloadedmetadata = () => resolve(probe.duration > 0 ? "loaded" : "empty");
        probe.onerror = () => resolve("error");
        setTimeout(() => resolve("timeout"), 8000);
        probe.src = source;
      }),
    [selector, index] as const,
  );
}

test("Demo Mode needs a researcher while the demo is not public", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const access = await context.request.get("/api/demo/session");
  test.skip(access.status() === 200, "The study setting demoPublic is true on this server.");
  expect(access.status()).toBe(401);

  const page = await context.newPage();
  await page.goto("/demo");
  await expect(page).toHaveURL(/\/admin\/login\?next=(%2F|\/)demo$/);
  await context.close();
});

test("Demo Mode: record, transcript, two translations and two playable syntheses (mock provider)", async ({ page, context }) => {
  test.setTimeout(120_000);
  const problems = watch(page);
  await signInAsAdmin(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/demo?provider=mock");

  // The DEMO banner is there from the first render and stays.
  const banner = page.getByRole("region", { name: "DEMO mode" });
  await expect(banner).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Speech translation demo" })).toBeVisible();
  // The mock option is labelled before anything is recorded.
  await expect(page.getByText("MOCK PROVIDER, not real model output")).toBeVisible();

  // The microphone is not used before the visitor agrees to the recording notice.
  const notice = page.getByTestId("demo-notice");
  await expect(notice).toContainText("Your voice is recorded");
  await expect(notice).toContainText("external AI service");
  await expect(page.getByRole("button", { name: "Start recording" })).toHaveCount(0);
  await notice.getByRole("button", { name: "I agree, use the microphone" }).click();

  // The capture option is under "Options", lossless by default.
  await page.getByTestId("demo-options").locator("summary").click();
  await expect(page.getByRole("radio", { name: /Lossless/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Mock provider/ })).toBeChecked();
  await page.getByTestId("demo-options").locator("summary").click();

  await page.getByRole("button", { name: "Start recording" }).click();
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Send to the pipeline" }).click();

  // Transcript, then the two columns, then the audio.
  await expect(page.getByTestId("demo-transcript")).toContainText("[mock-transkriptio", { timeout: 30_000 });
  const translations = page.getByTestId("demo-translation-text");
  await expect(translations).toHaveCount(2, { timeout: 30_000 });
  await expect(translations.nth(0)).toContainText("[mock translation");
  await expect(translations.nth(1)).toContainText("[mock translation");
  await expect(page.getByRole("heading", { level: 3, name: "Default translation" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Preserve variation" })).toBeVisible();

  const progress = page.getByTestId("demo-progress");
  for (const stage of ["asr", "translation", "tts"]) {
    await expect(progress.locator(`[data-stage="${stage}"]`)).toHaveAttribute("data-state", "done", { timeout: 30_000 });
  }
  await expect(page.getByTestId("demo-announcement")).toHaveText("Speech synthesis finished. The results are shown below.");

  const players = page.locator("[data-condition] audio");
  await expect(players).toHaveCount(2);
  await expect(page.getByLabel("Synthesized speech: Default translation")).toBeVisible();
  await expect(page.getByLabel("Synthesized speech: Preserve variation")).toBeVisible();
  expect(await audioLoads(page, "[data-condition] audio", 0)).toBe("loaded");
  expect(await audioLoads(page, "[data-condition] audio", 1)).toBe("loaded");
  // The visitor can also play the source recording.
  expect(await audioLoads(page, '[data-testid="demo-result"] audio', 0)).toBe("loaded");

  // "Show pipeline" reveals model, prompt version and timing of each stage.
  await page.getByTestId("demo-pipeline").locator("summary").click();
  await expect(page.getByTestId("demo-pipeline")).toContainText("mock / mock-asr");
  await expect(page.getByTestId("demo-pipeline")).toContainText("mock_translation_preserve v1");
  await expect(page.getByTestId("demo-pipeline")).toContainText("demo batch");

  await expect(banner).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "demo.png"), fullPage: true });

  // The session is stored with the mode `demo` and is listed for the researcher.
  const session = await (await context.request.get("/api/demo/session")).json();
  const code: string = session.session.participantCode;
  expect(session.session.recordingCount).toBe(1);
  const list = await context.request.get(`/api/admin/sessions?mode=demo&search=${encodeURIComponent(code)}`);
  if (list.status() === 200) {
    const text = JSON.stringify(await list.json());
    expect(text).toContain(code);
    expect(text).toContain('"mode":"demo"');
    expect(text).not.toContain('"mode":"research"');
  } else {
    test.info().annotations.push({ type: "note", description: `GET /api/admin/sessions answered ${list.status()}, the list check was skipped.` });
  }

  // At 390 px the two columns stack and nothing overflows sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  const columns = page.locator("[data-condition]");
  const first = await columns.nth(0).boundingBox();
  const second = await columns.nth(1).boundingBox();
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(banner).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "demo-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // "Record another" keeps the session and offers the recorder again.
  await page.getByRole("button", { name: "Record another" }).click();
  await expect(page.getByRole("button", { name: "Start recording" })).toBeVisible();
  await expect(page.getByTestId("demo-result")).toHaveCount(0);

  // "Clear and start again" ends the session: the notice must be accepted again.
  await page.getByRole("button", { name: "Clear and start again" }).click();
  await expect(page.getByTestId("demo-notice")).toBeVisible();
  const afterClear = await (await context.request.get("/api/demo/session")).json();
  expect(afterClear.session).toBeNull();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("AI Pipeline: the pipeline test reports five rows, with the mock option and with the active configurations", async ({ page, context }) => {
  test.setTimeout(120_000);
  const problems = watch(page);
  await signInAsAdmin(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/ai-pipeline");

  const card = page.getByTestId("pipeline-test");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("heading", { name: "Run pipeline test" })).toBeVisible();
  const rows = card.locator("[data-testid='pipeline-test-result'] tbody tr");
  const tone = card.getByRole("button", { name: "Use a generated test tone" });

  // With the active configurations: without an API key the failure is said plainly.
  const providers = await (await context.request.get("/api/admin/ai/configs")).json();
  const openaiConfigured = (providers.providers as Array<{ name: string; configured: boolean }>).some(
    (provider) => provider.name === "openai" && provider.configured,
  );
  if (!openaiConfigured) {
    await expect(card.getByRole("radio", { name: /Active configurations/ })).toBeChecked();
    await tone.click();
    await expect(card.getByTestId("pipeline-test-result")).toHaveAttribute("data-passed", "false", { timeout: 60_000 });
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toHaveAttribute("data-result", "FAIL");
    await expect(rows.nth(0)).toContainText("The OpenAI API key is not configured on the server");
    await expect(rows.nth(4)).toHaveAttribute("data-row", "storage");
    await expect(rows.nth(4)).toHaveAttribute("data-result", "PASS");
  }

  // With the mock option: the plumbing passes, and the result is labelled as mock.
  await card.getByRole("radio", { name: /Mock provider/ }).check();
  await tone.click();
  await expect(card.getByTestId("pipeline-test-result")).toHaveAttribute("data-passed", "true", { timeout: 60_000 });
  await expect(rows).toHaveCount(5);
  const labels = ["ASR", "Default translation", "Preserve translation", "TTS", "Storage"];
  for (const [index, label] of labels.entries()) {
    await expect(rows.nth(index).locator("th")).toHaveText(label);
    await expect(rows.nth(index)).toHaveAttribute("data-result", "PASS");
    await expect(rows.nth(index)).toContainText("PASS");
  }
  await expect(card.getByText("Mock provider, not real model output")).toBeVisible();
  await expect(card.getByTestId("pipeline-test-result").getByText("Generated test tone")).toBeVisible();

  // The same with a clip recorded from the (test) microphone.
  await card.getByRole("button", { name: "Record a test clip" }).click();
  await expect(card.getByTestId("pipeline-test-recorder")).toHaveAttribute("data-state", "recording");
  await page.waitForTimeout(1500);
  await card.getByRole("button", { name: "Stop" }).click();
  await card.getByRole("button", { name: "Run pipeline test with this clip" }).click();
  await expect(card.getByTestId("pipeline-test-result").getByText("Recorded clip")).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId("pipeline-test-result")).toHaveAttribute("data-passed", "true");
  await expect(rows).toHaveCount(5);

  await card.screenshot({ path: path.join(SCREENSHOT_DIR, "pipeline-test.png") });

  // The last result is still shown after a reload, with its time.
  await page.reload();
  const reloaded = page.getByTestId("pipeline-test");
  await expect(reloaded.getByTestId("pipeline-test-result")).toHaveAttribute("data-passed", "true");
  await expect(reloaded.getByText("Last test")).toBeVisible();

  // Everything the test made is test data.
  const last = await (await context.request.get("/api/admin/ai/test")).json();
  expect(last.last.dataMode).toBe("test");

  expect(problems, problems.join("\n")).toEqual([]);
});
