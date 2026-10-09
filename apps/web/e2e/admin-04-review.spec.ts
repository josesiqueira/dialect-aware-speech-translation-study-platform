// Review & Transcription (spec 46 to 48, 157.6 to 157.9).
//
// The tests of this file run in order and build on each other: the third sample
// TEST session has no transcripts, so its first utterance is the one that gets a
// B transcript, a verification and a second revision.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openAdminPage, sampleSessions, type SessionListItem } from "./support/admin";

test.describe.configure({ mode: "serial" });

let samples: SessionListItem[];

test.beforeEach(async ({ page }) => {
  samples = await sampleSessions(page.context().request);
});

const DRAFT_TEXT = "mää oon vähä epävarma lähenkö mää sinne [e2e]";
const EDITED_TEXT = "mää oon vähä epävarma lähenkö mää sinne ollenkaa [e2e]";
const CHANGE_REASON = "e2e: one word was missing";

function queueRows(page: Page, code: string): Locator {
  return page.getByRole("main").getByRole("button", { name: new RegExp(`^${code} U-`) });
}

/** Opens the queue with TEST data and the utterances of one participant. */
async function openQueue(page: Page, code: string, reviewState = "All utterances"): Promise<void> {
  await openAdminPage(page, "/admin/review", "Review & Transcription");
  const filters = page.getByRole("search", { name: "Review queue filters" });
  // The default is research data only, where the e2e database has nothing.
  await expect(filters.getByLabel("Filter by data mode").locator("option:checked")).toHaveText("Research data");
  await expect(page.getByText("No utterances to review yet.")).toBeVisible();
  await filters.getByLabel("Filter by data mode").selectOption({ label: "TEST data only" });
  await filters.getByLabel("Filter by review state").selectOption({ label: reviewState });
  await filters.getByRole("searchbox", { name: "Search transcript text, participant code or utterance id" }).fill(code);
  await expect(queueRows(page, code).first()).toBeVisible();
}

function editor(page: Page, letter: "A*" | "B" | "C"): Locator {
  const names = { "A*": "A* ASR corrected", B: "B Human dialect-preserving", C: "C Normalized Finnish" };
  return page.getByRole("region", { name: names[letter] });
}

async function saveDraft(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

test("a B transcript is written as a draft and is still there after a reload", async ({ page }) => {
  const code = samples[2]!.participantCode;
  await openQueue(page, code, "B missing");
  await expect(queueRows(page, code)).toHaveCount(6);
  await expect(queueRows(page, code).first()).toContainText("TEST");
  await expect(queueRows(page, code).first()).toContainText("B missing");

  await queueRows(page, code).first().click();
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(`^${code} / U-`) })).toBeVisible();
  await expect(page.getByText("Prompt shown to the participant")).toBeVisible();
  const b = editor(page, "B");
  await expect(b.getByText("not started")).toBeVisible();
  await expect(b.getByText("No revisions yet")).toBeVisible();

  await b.getByRole("textbox", { name: "B transcript text" }).fill(DRAFT_TEXT);
  await expect(b.getByText("Unsaved changes")).toBeVisible();
  await saveDraft(page);
  await expect(b.getByText("draft", { exact: true })).toBeVisible();
  await expect(b.getByText("Revision history (1)")).toBeVisible();

  // The address holds the utterance, so a reload shows the same one with the stored text.
  await expect(page).toHaveURL(/utterance=[0-9a-f-]{36}/);
  await page.reload();
  await expect(editor(page, "B").getByRole("textbox", { name: "B transcript text" })).toHaveValue(DRAFT_TEXT);
  await expect(editor(page, "B").getByText("draft", { exact: true })).toBeVisible();
  test.info().annotations.push({ type: "utterance", description: page.url() });
  utteranceUrl = page.url();
});

let utteranceUrl = "";

test("the draft is verified, and editing a verified transcript needs a change reason and keeps revision 1", async ({ page }) => {
  expect(utteranceUrl, "the first test of this file stored the utterance address").not.toBe("");
  await page.goto(utteranceUrl);
  const b = editor(page, "B");
  const text = b.getByRole("textbox", { name: "B transcript text" });
  await expect(text).toHaveValue(DRAFT_TEXT);

  await b.getByRole("button", { name: "Mark B verified" }).click();
  await expect(b.getByText(/^.?verified$/).first()).toBeVisible();
  await expect(b.getByText(/^Verified \d{4}-\d{2}-\d{2}/)).toBeVisible();
  await expect(b.getByRole("button", { name: "Mark B verified" })).toBeDisabled();

  // Editing the verified text asks for a reason.
  await text.fill(EDITED_TEXT);
  const reason = b.getByRole("textbox", { name: /^Change reason/ });
  await expect(reason).toBeVisible();
  await expect(b.getByText("Saving creates a new revision and returns the transcript to draft.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(b.getByText("Give a change reason before saving.")).toBeVisible();
  await expect(b.getByText("Revision history (1)")).toBeVisible();

  await reason.fill(CHANGE_REASON);
  await saveDraft(page);
  await expect(b.getByText("draft", { exact: true })).toBeVisible();

  // Revision 2 is current, revision 1 is kept as it was verified.
  await b.getByText("Revision history (2)").click();
  const revisions = b.getByRole("listitem");
  await expect(revisions).toHaveCount(2);
  await expect(revisions.nth(0)).toContainText("Revision 2");
  await expect(revisions.nth(0)).toContainText("current");
  await expect(revisions.nth(0)).toContainText(EDITED_TEXT);
  await expect(revisions.nth(0)).toContainText(`Change reason: ${CHANGE_REASON}`);
  await expect(revisions.nth(1)).toContainText("Revision 1");
  await expect(revisions.nth(1)).toContainText("verified");
  await expect(revisions.nth(1)).toContainText(DRAFT_TEXT);
  await expect(revisions.nth(1)).not.toContainText("ollenkaa");
});

test("a C transcript is written from B and verified", async ({ page }) => {
  await page.goto(utteranceUrl);
  const c = editor(page, "C");
  await c.getByRole("button", { name: "Copy B into editor" }).click();
  await expect(c.getByRole("textbox", { name: "C transcript text" })).toHaveValue(EDITED_TEXT);
  await expect(c.getByText("Started from a copy of B.", { exact: false })).toBeVisible();
  await c.getByRole("textbox", { name: "C transcript text" }).fill("minä olen vähän epävarma lähdenkö minä sinne ollenkaan [e2e]");
  await c.getByRole("button", { name: "Mark C verified" }).click();
  await expect(c.getByText(/^.?verified$/).first()).toBeVisible();
  await expect(c.getByText("Revision history (1)")).toBeVisible();
});

test("an A versus B difference is coded with two categories", async ({ page }) => {
  // The first sample session has an ASR transcript and a human B transcript.
  const code = samples[0]!.participantCode;
  await openQueue(page, code);
  await queueRows(page, code).first().click();

  const coding = page.getByRole("region", { name: "Difference coding" });
  await expect(coding.getByLabel("Pair being coded").locator("option:checked")).toHaveText("A vs B");
  await expect(coding.getByText(/Coding A revision \d+ against B revision \d+/)).toBeVisible();

  await coding.getByRole("checkbox", { name: "Normalization" }).check();
  await coding.getByRole("checkbox", { name: "Omission" }).check();
  await coding.getByRole("textbox", { name: "Coding note" }).fill("e2e: two categories");
  await expect(coding.getByText("Unsaved changes")).toBeVisible();
  await saveDraft(page);
  await expect(coding.getByText(/1 coding record stored for this utterance/)).toBeVisible();

  await page.reload();
  const reloaded = page.getByRole("region", { name: "Difference coding" });
  await expect(reloaded.getByRole("checkbox", { name: "Normalization" })).toBeChecked();
  await expect(reloaded.getByRole("checkbox", { name: "Omission" })).toBeChecked();
  await expect(reloaded.getByRole("checkbox", { name: "Recognition error" })).not.toBeChecked();
  await expect(reloaded.getByText(/1 coding record stored for this utterance/)).toBeVisible();
});

test("Save & next stores the text and moves to the next utterance", async ({ page }) => {
  const code = samples[2]!.participantCode;
  await openQueue(page, code);
  await queueRows(page, code).nth(1).click();
  const heading = page.getByRole("heading", { level: 2, name: new RegExp(`^${code} / U-`) });
  await expect(heading).toBeVisible();
  const firstHeading = await heading.innerText();
  const firstUrl = page.url();

  await editor(page, "B").getByRole("textbox", { name: "B transcript text" }).fill("toinen lausuma [e2e]");
  await page.getByRole("button", { name: "Save & next" }).click();
  await expect(heading).not.toHaveText(firstHeading);
  await expect(page).not.toHaveURL(firstUrl);
  await expect(editor(page, "B").getByRole("textbox", { name: "B transcript text" })).toHaveValue("");

  // The text of the utterance that was left is stored.
  await page.goto(firstUrl);
  await expect(editor(page, "B").getByRole("textbox", { name: "B transcript text" })).toHaveValue("toinen lausuma [e2e]");
});

test("leaving with unsaved edits asks first", async ({ page }) => {
  const code = samples[2]!.participantCode;
  await openQueue(page, code);
  await queueRows(page, code).nth(2).click();
  const text = editor(page, "B").getByRole("textbox", { name: "B transcript text" });
  await text.fill("muokkaus jota ei tallenneta [e2e]");
  await expect(editor(page, "B").getByText("Unsaved changes")).toBeVisible();

  // A link of the sidebar: declined, the page and the text stay.
  const messages: string[] = [];
  page.once("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Dashboard" }).click();
  await expect.poll(() => messages).toEqual(["You have unsaved changes. Leave this page and discard them?"]);
  await expect(page).toHaveURL(/\/admin\/review/);
  await expect(text).toHaveValue("muokkaus jota ei tallenneta [e2e]");

  // Another utterance of the queue: declined as well.
  page.once("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  await queueRows(page, code).nth(3).click();
  await expect.poll(() => messages.length).toBe(2);
  await expect(text).toHaveValue("muokkaus jota ei tallenneta [e2e]");

  // Accepted: the Dashboard opens and nothing was stored.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
});
