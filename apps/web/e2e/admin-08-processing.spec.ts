// Processing Runs (spec 53, 54, 157.14 to 157.16): a batch over the sample TEST
// sessions is created with the wizard, run by the worker, and its outputs appear
// in Session Detail. A second batch fails on purpose and offers a retry.
//
// The wizard offers only the active model configurations (CreateBatchWizard.tsx,
// "No active ... configuration exists"). The sample sessions were processed with
// retired mock configurations that a batch can never select. So the first test
// activates mock-provider versions of the translation and TTS configurations
// through the admin API. That is legitimate here and only here: this database
// belongs to the isolated e2e environment, where AI_ALLOW_MOCK_PROVIDER=true.
//
// The tests of this file run in order.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { completedTestCorpus, getJson, openAdminPage, sampleSessions, sendJson } from "./support/admin";

test.describe.configure({ mode: "serial" });

type ModelConfig = { id: string; key: string; stage: string; status: string; versionNumber: number; provider: string };

const OK_BATCH = "e2e-mock-batch";
const FAILING_BATCH = "e2e-failing-batch";
const TRANSIENT_BATCH = "e2e-transient-batch";

/** Creates and activates a new version of a model configuration that uses the mock provider. */
async function activateMockVersion(
  request: APIRequestContext,
  key: string,
  modelId: string,
  parameters: Record<string, unknown>,
): Promise<ModelConfig> {
  const list = await getJson<{ configs: ModelConfig[] }>(request, `/api/admin/ai/configs?key=${key}`);
  const active = list.configs.find((config) => config.status === "active");
  expect(active, `active configuration ${key}`).toBeTruthy();
  const draft = await sendJson<{ config: ModelConfig }>(request, "POST", `/api/admin/ai/configs/${active!.id}/clone`);
  await sendJson(request, "PUT", `/api/admin/ai/configs/${draft.config.id}`, {
    provider: "mock",
    modelId,
    parameters,
    notes: "Activated by the end-to-end test setup. Mock provider, not real model output.",
  });
  await sendJson(request, "POST", `/api/admin/ai/configs/${draft.config.id}/activate`);
  const after = await getJson<{ configs: ModelConfig[] }>(request, `/api/admin/ai/configs?key=${key}`);
  const nowActive = after.configs.find((config) => config.status === "active");
  expect(nowActive?.provider).toBe("mock");
  return nowActive!;
}

function metric(card: Locator, label: string): Locator {
  return card.getByRole("article").filter({ has: card.page().getByText(label, { exact: true }) }).locator("p").nth(1);
}

async function next(wizard: Locator, step: string): Promise<void> {
  await wizard.getByRole("button", { name: "Next" }).click();
  await expect(wizard.locator('[aria-current="step"]')).toContainText(step);
}

/** Refreshes the batch list until the batch detail shows a final status. */
async function waitForBatch(page: Page, name: string, finalStatus: string): Promise<Locator> {
  const card = page.getByRole("region", { name: `Batch ${name}` });
  await expect(async () => {
    await page.getByRole("region", { name: "Batches" }).getByRole("button", { name: "Refresh" }).click();
    await expect(card.getByText(finalStatus, { exact: true }).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 240_000, intervals: [2_000] });
  return card;
}

test("setup: mock-provider versions of the translation and TTS configurations are activated", async ({ page }) => {
  const request = page.context().request;
  await activateMockVersion(request, "translation_default", "mock-translation", {});
  await activateMockVersion(request, "translation_preserve", "mock-translation", {});
  await activateMockVersion(request, "tts_baseline", "mock-tts", { voice: "mock-voice", response_format: "wav" });

  await openAdminPage(page, "/admin/ai-pipeline", "AI Pipeline");
  for (const name of ["Translation: Default", "Translation: Preservation", "TTS: Baseline"]) {
    const section = page.getByRole("region", { name, exact: true });
    await expect(section.locator("dt", { hasText: "Provider:" }).locator("xpath=following-sibling::dd[1]")).toContainText("mock");
  }
});

test("a batch over the TEST sessions is created with the wizard, run by the worker and completes", async ({ page }) => {
  test.setTimeout(300_000);
  await openAdminPage(page, "/admin/processing", "Processing Runs");
  // The completed TEST sessions: the three samples and what the pipeline test left.
  const corpus = await completedTestCorpus(page.context().request);
  await page.getByRole("button", { name: "Create batch" }).click();
  const wizard = page.getByRole("region", { name: "Create batch" });

  // 1. Corpus subset. The default mode is research, which holds nothing here.
  await expect(wizard.getByLabel("Data mode")).toHaveValue("research");
  await wizard.getByLabel("Data mode").selectOption("test");
  await expect(wizard.getByRole("checkbox", { name: "Completed sessions only" })).toBeChecked();
  await expect(wizard.getByRole("checkbox", { name: /^Verified transcripts only/ })).toBeChecked();

  // 2. Transcript types: A, B and C are ticked.
  await next(wizard, "Transcript types");
  await expect(wizard.getByRole("checkbox", { name: /^A: / })).toBeChecked();
  await expect(wizard.getByRole("checkbox", { name: /^B: / })).toBeChecked();
  await expect(wizard.getByRole("checkbox", { name: /^C: / })).toBeChecked();

  // 3. ASR: not part of this batch (the active ASR configuration needs an API key).
  await next(wizard, "ASR");
  await expect(wizard.getByRole("checkbox", { name: /^Run ASR in this batch/ })).not.toBeChecked();

  // 4. Translation conditions: both active mock configurations.
  await next(wizard, "Translation conditions");
  await expect(wizard.getByRole("checkbox", { name: /translation_default v\d+/ })).toBeChecked();
  await expect(wizard.getByRole("checkbox", { name: /translation_preserve v\d+/ })).toBeChecked();
  await expect(wizard.getByRole("group", { name: "Translation conditions" })).toContainText("mock mock-translation");

  // 5. TTS.
  await next(wizard, "TTS conditions");
  await expect(wizard.getByRole("checkbox", { name: /tts_baseline v\d+/ })).toBeChecked();

  // 6. Estimated workload.
  await next(wizard, "Estimated workload");
  await expect(metric(wizard, "Jobs in total")).toHaveText(/^[1-9]\d*$/);
  const estimatedJobs = Number(await metric(wizard, "Jobs in total").innerText());
  const translationJobs = Number(await metric(wizard, "Translation jobs").innerText());
  expect(Number(await metric(wizard, "ASR jobs").innerText())).toBe(0);
  expect(Number(await metric(wizard, "Sessions").innerText())).toBe(corpus.sessions.length);
  expect(Number(await metric(wizard, "Utterances").innerText())).toBe(corpus.utterances);
  // Each translation is synthesized once.
  expect(Number(await metric(wizard, "TTS jobs").innerText())).toBe(translationJobs);
  expect(estimatedJobs).toBe(translationJobs * 2);
  await expect(wizard).toContainText("Data mode");

  // 7. Create.
  await wizard.getByRole("button", { name: "Next" }).click();
  await wizard.getByRole("textbox", { name: /^Batch name/ }).fill(OK_BATCH);
  await wizard.getByRole("textbox", { name: "Description" }).fill("Created by the end-to-end test. Mock provider.");
  await wizard.getByRole("button", { name: "Create batch" }).click();
  await expect(wizard.getByText(`The batch was created as a draft with ${corpus.utterances} utterances.`)).toBeVisible();

  // 8. Run.
  await wizard.getByRole("button", { name: "Start batch" }).click();
  const dialog = page.getByRole("dialog", { name: "Start this batch?" });
  await expect(dialog).toContainText("After the start the configuration cannot change.");
  await dialog.getByRole("button", { name: "Start batch" }).click();
  await expect(dialog).toBeHidden();

  // The worker runs the jobs. The page is refreshed until the batch is done.
  const card = await waitForBatch(page, OK_BATCH, "Completed");
  await expect(metric(card, "Jobs")).toHaveText(String(estimatedJobs));
  await expect(metric(card, "Succeeded")).toHaveText(String(estimatedJobs));
  await expect(metric(card, "Failed")).toHaveText("0");
  await expect(metric(card, "Queued")).toHaveText("0");
  await expect(metric(card, "Running")).toHaveText("0");
  await expect(card.getByText("No failed jobs.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Retry failed" })).toHaveCount(0);
  await expect(card).toContainText(`${translationJobs} translations`);
  await expect(card).toContainText(`${translationJobs} TTS files`);

  // The list row carries the mode badge and the frozen configuration labels.
  const row = page.getByRole("table", { name: "Processing batches" }).getByRole("row").filter({ hasText: OK_BATCH });
  await expect(row).toContainText("test");
  await expect(row).toContainText("Completed");
  await expect(row).toContainText(/translation_default v\d+/);
  await expect(row).toContainText(/tts_baseline v\d+/);
});

test("the outputs of the new batch appear in Session Detail with playable TTS audio", async ({ page }) => {
  const session = (await sampleSessions(page.context().request))[0]!;
  const mediaStatuses: number[] = [];
  page.on("response", (response) => {
    if (/\/api\/admin\/media\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname)) mediaStatuses.push(response.status());
  });

  await openAdminPage(page, `/admin/sessions?session=${session.id}`, "Sessions");
  const utterance = page.getByRole("article", { name: "Utterance U-01" });
  const matrix = utterance.getByRole("table", { name: `Translations of batch ${OK_BATCH} by transcript and condition` });
  await expect(matrix).toBeVisible();
  // The earlier batch of the seed is still listed apart: outputs are grouped by batch.
  await expect(utterance.getByRole("table", { name: `Translations of batch sample-${session.participantCode} by transcript and condition` })).toBeVisible();

  const cell = matrix.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "B", exact: true }) }).getByRole("cell").first();
  await expect(cell).toContainText("[mock translation");
  await expect(cell).toContainText(/translation_default v\d+/);

  await cell.locator("details summary").click();
  const provenance = cell.locator("details");
  await expect(provenance.locator("dt", { hasText: /^Batch$/ }).locator("xpath=following-sibling::dd[1]")).toContainText(OK_BATCH);
  await expect(provenance.locator("dt", { hasText: /^App version$/ }).first().locator("xpath=following-sibling::dd[1]")).toContainText("0.1.0-e2e");

  // Play the synthesized speech: the audio is fetched only now.
  expect(mediaStatuses).toEqual([]);
  await cell.getByRole("button", { name: /^Play TTS/ }).click();
  const audio = cell.locator("audio");
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState), { message: "TTS audio metadata loaded" })
    .toBeGreaterThanOrEqual(1);
  expect(await audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(0);
  expect(mediaStatuses.length).toBeGreaterThan(0);
  for (const status of mediaStatuses) expect([200, 206]).toContain(status);
});

test("a batch whose configuration fails permanently ends as completed with errors and offers Retry failed", async ({ page }) => {
  test.setTimeout(300_000);
  const request = page.context().request;
  // A new version of the default translation configuration that always fails (packages/ai/README.md, mockFail).
  const failing = await activateMockVersion(request, "translation_default", "mock-translation", { mockFail: "permanent" });

  await openAdminPage(page, "/admin/processing", "Processing Runs");
  await page.getByRole("button", { name: "Create batch" }).click();
  const wizard = page.getByRole("region", { name: "Create batch" });
  await wizard.getByLabel("Data mode").selectOption("test");
  await next(wizard, "Transcript types");
  // Only A, to keep the batch small.
  await wizard.getByRole("checkbox", { name: /^B: / }).uncheck();
  await wizard.getByRole("checkbox", { name: /^C: / }).uncheck();
  await next(wizard, "ASR");
  await next(wizard, "Translation conditions");
  await wizard.getByRole("checkbox", { name: /translation_preserve v\d+/ }).uncheck();
  await expect(wizard.getByRole("checkbox", { name: new RegExp(`translation_default v${failing.versionNumber}`) })).toBeChecked();
  await next(wizard, "TTS conditions");
  await next(wizard, "Estimated workload");
  await expect(metric(wizard, "Translation jobs")).toHaveText(/^[1-9]\d*$/);
  const translationJobs = Number(await metric(wizard, "Translation jobs").innerText());
  await wizard.getByRole("button", { name: "Next" }).click();
  await wizard.getByRole("textbox", { name: /^Batch name/ }).fill(FAILING_BATCH);
  await wizard.getByRole("button", { name: "Create batch" }).click();
  await wizard.getByRole("button", { name: "Start batch" }).click();
  await page.getByRole("dialog", { name: "Start this batch?" }).getByRole("button", { name: "Start batch" }).click();

  const card = await waitForBatch(page, FAILING_BATCH, "Completed with errors");
  await expect(metric(card, "Failed")).toHaveText(String(translationJobs));
  await expect(metric(card, "Succeeded")).toHaveText("0");
  const failed = card.getByRole("table", { name: "Failed jobs of this batch" });
  await expect(failed.getByRole("row").nth(1)).toContainText("translation");
  await expect(failed.getByRole("row").nth(1)).toContainText(/mock/i);
  await expect(card.getByRole("button", { name: "Retry failed" })).toBeEnabled();

  // The retry is offered with a confirmation. It is not confirmed here: the
  // frozen configuration would fail again.
  await card.getByRole("button", { name: "Retry failed" }).click();
  const dialog = page.getByRole("dialog", { name: "Retry the failed jobs?" });
  await expect(dialog.getByRole("button", { name: "Retry failed" })).toBeVisible();
  await dialog.getByRole("button", { name: "Keep as is" }).click();
  await expect(dialog).toBeHidden();

  // The Dashboard counts the failures as processing errors.
  await openAdminPage(page, "/admin", "Dashboard");
  const errors = page.getByRole("article").filter({ has: page.getByText("Processing errors", { exact: true }) });
  await expect(errors).not.toContainText("0 jobs, 0 model runs");

  // Leave a working (mock) default translation configuration active for later specs.
  await activateMockVersion(request, "translation_default", "mock-translation", {});
});

test("Retry failed runs the failed jobs of a batch again, and a transient failure then succeeds", async ({ page }) => {
  test.setTimeout(420_000);
  const request = page.context().request;
  // The first call for each input fails, the next one succeeds (packages/ai/README.md,
  // mockFailTimes). The failure is marked permanent, so the queue does not try again by
  // itself: the second call happens only through "Retry failed". The model name is
  // used by this test only, so the calls of the other batches are not counted.
  const transient = await activateMockVersion(request, "translation_default", "mock-translation-transient", {
    mockFail: "permanent",
    mockFailTimes: 1,
  });

  try {
    await openAdminPage(page, "/admin/processing", "Processing Runs");
    await page.getByRole("button", { name: "Create batch" }).click();
    const wizard = page.getByRole("region", { name: "Create batch" });
    await wizard.getByLabel("Data mode").selectOption("test");
    await next(wizard, "Transcript types");
    // Only A, to keep the batch small.
    await wizard.getByRole("checkbox", { name: /^B: / }).uncheck();
    await wizard.getByRole("checkbox", { name: /^C: / }).uncheck();
    await next(wizard, "ASR");
    await next(wizard, "Translation conditions");
    await wizard.getByRole("checkbox", { name: /translation_preserve v\d+/ }).uncheck();
    await expect(wizard.getByRole("checkbox", { name: new RegExp(`translation_default v${transient.versionNumber}`) })).toBeChecked();
    await next(wizard, "TTS conditions");
    await next(wizard, "Estimated workload");
    const estimatedJobs = Number(await metric(wizard, "Jobs in total").innerText());
    const translationJobs = Number(await metric(wizard, "Translation jobs").innerText());
    expect(translationJobs).toBeGreaterThan(0);
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByRole("textbox", { name: /^Batch name/ }).fill(TRANSIENT_BATCH);
    await wizard.getByRole("button", { name: "Create batch" }).click();
    await wizard.getByRole("button", { name: "Start batch" }).click();
    await page.getByRole("dialog", { name: "Start this batch?" }).getByRole("button", { name: "Start batch" }).click();

    // First run: at least one translation fails (one per distinct input text).
    const card = await waitForBatch(page, TRANSIENT_BATCH, "Completed with errors");
    const failedBefore = Number(await metric(card, "Failed").innerText());
    expect(failedBefore).toBeGreaterThan(0);
    expect(failedBefore).toBeLessThanOrEqual(translationJobs);
    const failed = card.getByRole("table", { name: "Failed jobs of this batch" });
    await expect(failed.getByRole("row").nth(1)).toContainText("translation");
    await expect(failed.getByRole("row").nth(1)).toContainText(/injected permanent failure \(call 1 for this input\)/);

    // The retry is confirmed this time.
    await card.getByRole("button", { name: "Retry failed" }).click();
    const dialog = page.getByRole("dialog", { name: "Retry the failed jobs?" });
    await dialog.getByRole("button", { name: "Retry failed" }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByText(/Queued again: [\d,]+ failed jobs?\. Succeeded jobs are not run again\./)).toBeVisible();

    // Second run: the same jobs succeed, their TTS jobs follow, and nothing is left failed.
    const done = await waitForBatch(page, TRANSIENT_BATCH, "Completed");
    await expect(metric(done, "Failed")).toHaveText("0");
    await expect(metric(done, "Queued")).toHaveText("0");
    await expect(metric(done, "Running")).toHaveText("0");
    await expect(metric(done, "Jobs")).toHaveText(String(estimatedJobs));
    await expect(metric(done, "Succeeded")).toHaveText(String(estimatedJobs));
    await expect(done.getByText("No failed jobs.")).toBeVisible();
    await expect(done.getByRole("button", { name: "Retry failed" })).toHaveCount(0);
    await expect(done).toContainText(`${translationJobs} translations`);
  } finally {
    // Leave a working (mock) default translation configuration active for later specs.
    await activateMockVersion(request, "translation_default", "mock-translation", {});
  }
});
