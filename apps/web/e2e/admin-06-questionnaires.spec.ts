// Questionnaires (spec 55, 130): a draft under a new key gets three items, is
// reordered, previewed, published, and is then immutable.
//
// The questionnaire is created under its own key, so no protocol selects it and
// the participant flow of the other specs is not affected.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openAdminPage } from "./support/admin";

const KEY = "e2e_source_speaker_evaluation";
const LABEL = `${KEY} v1`;
const LIKERT_PROMPT = "How natural did the speaker sound?";
const CHOICE_PROMPT = "Would you want to hear this speaker again?";
const TEXT_PROMPT = "Describe the speaker in your own words.";

function item(page: Page, position: number): Locator {
  return page.getByRole("main").locator("ol > li").filter({ has: page.getByRole("button", { name: new RegExp(`^(Edit|Close) item ${position}$`) }) });
}

async function addItem(page: Page, position: number, prompt: string, type: string): Promise<Locator> {
  await page.getByRole("button", { name: "Add item" }).click();
  const row = item(page, position);
  // A new item opens for editing.
  await expect(row.getByRole("textbox", { name: /^Prompt/ })).toBeVisible();
  await row.getByRole("textbox", { name: /^Prompt/ }).fill(prompt);
  await row.getByLabel("Response type").selectOption({ label: type });
  return row;
}

test("a questionnaire draft is created, filled, reordered, previewed, published, and is then immutable", async ({ page }) => {
  await openAdminPage(page, "/admin/questionnaires", "Questionnaires");

  // Create the draft under a new key.
  await page.getByRole("button", { name: "New questionnaire" }).click();
  await page.getByRole("textbox", { name: /^Key/ }).fill(KEY);
  await page.getByRole("textbox", { name: /^Name/ }).fill("Source speaker evaluation (e2e)");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("heading", { level: 2, name: LABEL })).toBeVisible();
  await expect(page.getByText("This draft has no items yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();

  // Likert item.
  const likert = await addItem(page, 1, LIKERT_PROMPT, "Likert scale");
  await likert.getByLabel("Label of the lowest point").fill("Not at all natural");
  await likert.getByLabel("Label of the highest point").fill("Completely natural");

  // Single choice item with two options.
  const choice = await addItem(page, 2, CHOICE_PROMPT, "Radio (one choice)");
  await choice.getByRole("button", { name: "Add option" }).click();
  await choice.getByLabel("Label of option 1").fill("Yes");
  await choice.getByRole("button", { name: "Add option" }).click();
  await choice.getByLabel("Label of option 2").fill("No");

  // Free text item.
  await addItem(page, 3, TEXT_PROMPT, "Free text");

  // Reorder: the free text item moves up, in front of the choice item.
  await page.getByRole("button", { name: "Move item 3 up" }).click();
  await expect(item(page, 2)).toContainText(TEXT_PROMPT);
  await expect(item(page, 3)).toContainText(CHOICE_PROMPT);
  await expect(item(page, 1)).toContainText(LIKERT_PROMPT);

  // Save.
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("All changes saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();

  // Preview: the banner is shown and nothing is sent to the server.
  const writes: string[] = [];
  const recordWrites = (request: { method: () => string; url: () => string }) => {
    if (request.method() !== "GET") writes.push(`${request.method()} ${request.url()}`);
  };
  page.on("request", recordWrites);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const main = page.getByRole("main");
  await expect(main.getByText("PREVIEW - NOT RESEARCH DATA")).toBeVisible();
  await expect(main.getByRole("heading", { name: "Source speaker evaluation (e2e)" })).toBeVisible();
  const prompts = [LIKERT_PROMPT, TEXT_PROMPT, CHOICE_PROMPT];
  for (const prompt of prompts) await expect(main.getByText(prompt).first()).toBeVisible();
  // The order in the preview is the order of the editor.
  const previewText = await main.innerText();
  expect(previewText.indexOf(LIKERT_PROMPT)).toBeLessThan(previewText.indexOf(TEXT_PROMPT));
  expect(previewText.indexOf(TEXT_PROMPT)).toBeLessThan(previewText.indexOf(CHOICE_PROMPT));
  await main.getByRole("radio", { name: "Yes", exact: true }).check();
  await expect(main.getByText("Not at all natural")).toBeVisible();
  await page.getByRole("button", { name: "Back to editor" }).click();
  page.off("request", recordWrites);
  expect(writes, "requests that change data during the preview").toEqual([]);

  // A reload shows the stored draft.
  await page.reload();
  await page.getByRole("region", { name: "Questionnaires and versions" }).getByRole("button", { name: /^v1 Draft/ }).click();
  await expect(item(page, 1)).toContainText(LIKERT_PROMPT);
  await expect(item(page, 2)).toContainText(TEXT_PROMPT);
  await expect(item(page, 3)).toContainText(CHOICE_PROMPT);

  // Publish.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Publish ${LABEL}?` });
  await expect(dialog).toContainText("A published version is immutable.");
  await dialog.getByRole("button", { name: "Publish version" }).click();
  await expect(dialog).toBeHidden();

  // Published and read-only.
  await expect(page.getByText("Read-only. A published version never changes.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Questionnaires and versions" }).getByRole("button", { name: /^v1 Published 3 items/ }).last()).toBeVisible();
  const items = page.getByRole("region", { name: "Items" });
  await expect(items.getByRole("listitem")).toHaveCount(3);
  await expect(items).toContainText(LIKERT_PROMPT);
  await expect(items.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Edit|Close|Move) item/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add item" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clone to new draft" })).toBeVisible();
});
