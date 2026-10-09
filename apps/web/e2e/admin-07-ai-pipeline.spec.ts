// AI Pipeline (spec 50 to 52, 157.13, docs/AI-PROVENANCE.md): versions of prompts
// and model configurations, activation with a confirmation that shows the
// difference, and the pipeline test.
//
// The tests of this file run in order. After this file the prompt
// translation_preserve has an active version 2, while the active model
// configuration translation_preserve v1 still pins prompt version 1.
import { expect, test } from "@playwright/test";
import { getJson, openAdminPage } from "./support/admin";

test.describe.configure({ mode: "serial" });

const SECTIONS = ["ASR", "Translation: Default", "Translation: Preservation", "TTS: Baseline"];
const ADDED_SENTENCE = "Keep hesitations and repetitions. [e2e prompt v2]";

/** The version numbers shown as active in a section, in page order: the prompt, then the model configuration. */
function activeVersions(text: string): string[] {
  return [...text.matchAll(/Active\s*v(\d+)/g)].map((match) => match[1]!);
}

test("the four sections show the active prompt and model configuration versions", async ({ page }) => {
  await openAdminPage(page, "/admin/ai-pipeline", "AI Pipeline");
  for (const name of SECTIONS) {
    const section = page.getByRole("region", { name, exact: true });
    await expect(section.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
    await expect(section.getByRole("heading", { level: 3, name: "Model configuration" })).toBeVisible();
    // One active prompt version and one active configuration version.
    await expect.poll(async () => activeVersions(await section.innerText())).toEqual(["1", "1"]);
    await expect(section.getByText(/^Config key /)).toBeVisible();
  }
  const providers = page.getByRole("region", { name: "Providers on this server" });
  await expect(providers).toContainText("No OpenAI API key");
  await expect(providers).toContainText("Not a real model.");
});

test("a draft of the preservation prompt is compared and activated, and the model configuration says it still uses the older prompt", async ({
  page,
}) => {
  await openAdminPage(page, "/admin/ai-pipeline", "AI Pipeline");
  const section = page.getByRole("region", { name: "Translation: Preservation", exact: true });

  // The active version is read-only: Edit creates a draft.
  await section.getByRole("button", { name: "Edit" }).first().click();
  const text = section.getByRole("textbox", { name: "Instruction text" });
  const original = await text.inputValue();
  expect(original).toContain("Translate the following Finnish utterance");
  await text.fill(`${original} ${ADDED_SENTENCE}`);
  await section.getByRole("button", { name: "Save draft" }).click();
  const draft = section.getByTestId("draft-panel");
  await expect(draft).toContainText("Draft");
  await expect(draft).toContainText(ADDED_SENTENCE);
  // The active version did not change.
  expect(activeVersions(await section.innerText())).toEqual(["1", "1"]);

  // Compare version 1 with version 2.
  const history = section.locator("details").filter({ hasText: "Version history and comparison" }).first();
  await history.locator("summary").click();
  await expect(history).toContainText("2 versions");
  await history.getByLabel("From").selectOption({ index: 1 });
  await history.getByLabel("To").selectOption({ index: 0 });
  const from = await history.getByLabel("From").locator("option:checked").innerText();
  const to = await history.getByLabel("To").locator("option:checked").innerText();
  expect(from).not.toBe(to);
  await history.getByRole("button", { name: "Compare versions" }).click();
  await expect(history.getByText("Prompt text", { exact: true })).toBeVisible();
  await expect(history).toContainText("[e2e prompt v2]");

  // Activate, with the difference in the confirmation.
  await draft.getByRole("button", { name: "Activate" }).click();
  const dialog = page.getByRole("dialog", { name: "Activate translation_preserve v2?" });
  await expect(dialog).toContainText("Version 1 is retired and stays stored unchanged.");
  await expect(dialog).toContainText("Existing model runs and existing batches are not changed.");
  await expect(dialog).toContainText("[e2e prompt v2]");
  await dialog.getByRole("button", { name: "Activate v2" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => activeVersions(await section.innerText())).toEqual(["2", "1"]);
  await expect(section).toContainText("Prompt key translation_preserve, prompt version 2");

  // The active model configuration still pins prompt version 1 and says so.
  await expect(section.getByText("Uses prompt v1, active prompt is v2")).toBeVisible();
  await expect(section).toContainText("Nothing is switched automatically.");
  await expect(section.getByRole("button", { name: "Create config draft with the active prompt" })).toBeEnabled();
  const configs = await getJson<{ configs: Array<{ key: string; status: string; versionNumber: number; prompt?: { versionNumber: number } | null }> }>(
    page.context().request,
    "/api/admin/ai/configs?key=translation_preserve",
  );
  const active = configs.configs.find((config) => config.status === "active");
  expect(active?.versionNumber).toBe(1);

  // The Dashboard status names the configuration with the prompt version it uses.
  await openAdminPage(page, "/admin", "Dashboard");
  await expect(page.getByRole("region", { name: "Status" })).toContainText("prompt translation_preserve v1");
});

test("the pipeline test passes all five rows with the mock provider option", async ({ page }) => {
  test.setTimeout(120_000);
  await openAdminPage(page, "/admin/ai-pipeline", "AI Pipeline");
  const card = page.getByRole("region", { name: "Run pipeline test" });
  await card.getByRole("radio", { name: "Mock provider" }).check();
  await card.getByRole("button", { name: "Use a generated test tone" }).click();

  const result = card.getByTestId("pipeline-test-result");
  await expect(result).toHaveAttribute("data-passed", "true", { timeout: 60_000 });
  const rows = result.locator("tbody tr");
  await expect(rows).toHaveCount(5);
  const labels = ["ASR", "Default translation", "Preserve translation", "TTS", "Storage"];
  for (const [index, label] of labels.entries()) {
    await expect(rows.nth(index).getByRole("rowheader")).toHaveText(label);
    await expect(rows.nth(index)).toContainText("PASS");
  }
  await expect(card.getByText("Mock provider, not real model output")).toBeVisible();
});

test("with the active configurations and no API key the failure is said plainly", async ({ page }) => {
  test.setTimeout(120_000);
  await openAdminPage(page, "/admin/ai-pipeline", "AI Pipeline");
  const card = page.getByRole("region", { name: "Run pipeline test" });
  await expect(card.getByRole("radio", { name: "Active configurations" })).toBeChecked();
  await card.getByRole("button", { name: "Use a generated test tone" }).click();

  const result = card.getByTestId("pipeline-test-result");
  await expect(result).toHaveAttribute("data-passed", "false", { timeout: 60_000 });
  const rows = result.locator("tbody tr");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText("FAIL");
  await expect(rows.nth(0)).toContainText("The OpenAI API key is not configured on the server");
  // Storage does not need a provider, so that row still passes.
  await expect(rows.nth(4).getByRole("rowheader")).toHaveText("Storage");
  await expect(rows.nth(4)).toContainText("PASS");
});
