// Study Flow (spec 49, 157.10 to 157.12, docs/PROTOCOL-VERSIONING.md): the
// published protocol is read-only, the draft is edited, previewed and published,
// new sessions get the new version and old sessions keep their own texts.
//
// The tests of this file run in order. After this file protocol v2 is the
// current protocol of the e2e study.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { getJson, openAdminPage, sampleSessions, sendJson, testSessions } from "./support/admin";

test.describe.configure({ mode: "serial" });

const OLD_PROMPT =
  "Imagine an English-speaking friend has invited you somewhere this weekend. Respond naturally in Finnish and explain that you are unsure whether you want to go.";
const PROMPT_ADDITION = "Answer in two or three sentences. [e2e edit]";
const NEW_PROMPT = `${OLD_PROMPT} ${PROMPT_ADDITION}`;
const WELCOME_ADDITION = "This welcome text was edited by the end-to-end test.";
const FOLLOWUP_TEXT = "What did you expect to happen instead? [e2e follow-up]";
// Study texts without the example text marker of the seed. A protocol that still
// contains example text cannot be published (packages/research/src/protocols/validation.ts).
const WELCOME_TEXT = `Welcome to the end-to-end test study. Your voice will be recorded.\n\n${WELCOME_ADDITION}`;
const TEXT_CARDS: Array<[card: string, text: string]> = [
  ["Welcome text", WELCOME_TEXT],
  ["Participant information text", "Information sheet of the end-to-end test study. Nothing here is real study content."],
  ["Study instructions", "You will see a few short speaking tasks, one at a time. Record your answer to each."],
  ["Debrief text", "Thank you for taking part in the end-to-end test study."],
];

type ConsentVersion = { id: string; versionNumber: number; status: string };

/** Publishes a consent version without example text, through the admin API. Returns its version number. */
async function publishConsentWithoutExampleText(request: APIRequestContext): Promise<number> {
  const list = () => getJson<{ consents: ConsentVersion[] }>(request, "/api/admin/consents");
  const published = (await list()).consents.find((consent) => consent.status === "published");
  expect(published, "the seeded published consent version").toBeTruthy();
  await sendJson(request, "POST", `/api/admin/consents/${published!.id}/clone`);
  const draft = (await list()).consents.find((consent) => consent.status === "draft");
  expect(draft, "the consent draft").toBeTruthy();
  await sendJson(request, "PUT", `/api/admin/consents/${draft!.id}`, {
    informationText: "Information about the end-to-end test study. Your recordings are test data.",
    contactText: "Contact: the research team of the end-to-end test study.",
    // No Finnish versions: the seeded Finnish texts still carry the example marker,
    // and a text without a translation falls back to the English one above.
    translations: {},
  });
  await sendJson(request, "POST", `/api/admin/consents/${draft!.id}/publish`);
  const after = (await list()).consents.find((consent) => consent.id === draft!.id);
  expect(after?.status).toBe("published");
  return after!.versionNumber;
}

function controlledTasks(page: Page): Locator {
  return page.getByRole("region", { name: "Block Controlled tasks" }).locator("ol > li, ul > li").filter({ hasText: /controlled_/ });
}

async function openDraft(page: Page): Promise<Locator> {
  await openAdminPage(page, "/admin/study-flow", "Study Flow");
  await page.getByRole("button", { name: "Edit Protocol v2" }).click();
  const content = page.getByRole("region", { name: "Protocol v2 content" });
  await expect(content.getByRole("heading", { name: "Editing Protocol v2" })).toBeVisible();
  return content;
}

test("the published protocol is read-only", async ({ page }) => {
  await openAdminPage(page, "/admin/study-flow", "Study Flow");
  const status = page.getByRole("region", { name: "Protocol status" });
  await expect(status).toContainText(/Published:\s*Protocol v1\s*Initial study flow/);
  const versions = page.getByRole("table", { name: "Protocol versions, newest first" });
  await expect(versions.getByRole("row").filter({ hasText: "Protocol v1" })).toContainText("Current for new sessions");
  // A draft exists already (from the seed), so cloning is not offered a second time.
  await expect(status.getByRole("button", { name: "Clone published version to new draft" })).toBeDisabled();

  await page.getByRole("button", { name: "View Protocol v1" }).click();
  const content = page.getByRole("region", { name: "Protocol v1 content" });
  await expect(content).toContainText(OLD_PROMPT);
  await expect(content.getByText("Published", { exact: true }).first()).toBeVisible();
  // No control that changes anything.
  await expect(content.getByRole("button", { name: /^(Edit|Save|Delete|Disable|Enable|Clone task|Add|Move) / })).toHaveCount(0);
  await expect(content.getByRole("button", { name: "Add task" })).toHaveCount(0);
  await expect(content.getByRole("textbox")).toHaveCount(0);

  // The server refuses a change as well.
  const request = page.context().request;
  const list = await getJson<{ protocols: Array<{ id: string; versionNumber: number }> }>(request, "/api/admin/protocols");
  const published = list.protocols.find((protocol) => protocol.versionNumber === 1);
  expect(published).toBeTruthy();
  const refused = await request.fetch(`/api/admin/protocols/${published!.id}`, {
    method: "PUT",
    headers: { Origin: new URL(page.url()).origin },
    data: { welcomeText: "changed" },
  });
  expect([400, 409, 422]).toContain(refused.status());
});

test("a draft that still contains the example text of the seed cannot be published", async ({ page }) => {
  await openDraft(page);
  await page.getByRole("region", { name: "Protocol status" }).getByRole("button", { name: "Publish draft" }).click();
  const review = page.getByRole("region", { name: "Review before publishing Protocol v2" });
  const check = review.getByRole("region", { name: "Publish check" });
  await expect(check.getByText(/\d+ problems? must be fixed before publishing/)).toBeVisible();
  await expect(check).toContainText("The welcome text still contains example text. Replace it with the approved study text.");
  await expect(check).toContainText("The information text of consent v1 still contains example text.");
  await expect(review.getByRole("button", { name: "Publish Protocol v2" })).toBeDisabled();
  await expect(review.getByText("Publishing is available when the problems above are fixed.")).toBeVisible();
});

test("the draft is edited: study texts, consent version, a task prompt, a new follow-up, and the task order", async ({ page }) => {
  const content = await openDraft(page);

  // General: the description of the seed carries the example marker as well.
  const general = content.getByRole("region", { name: "General" });
  await general.getByRole("button", { name: "Edit General" }).click();
  await general.getByRole("textbox", { name: "Description" }).fill("Protocol of the end-to-end test. Not a study.");
  await general.getByRole("button", { name: "Save", exact: true }).click();
  await expect(general.getByRole("button", { name: "Edit General" })).toBeVisible();

  // Welcome, information, instructions and debrief texts.
  for (const [cardName, text] of TEXT_CARDS) {
    const textCard = content.getByRole("region", { name: cardName }).first();
    await textCard.getByRole("button", { name: `Edit ${cardName}` }).click();
    const box = textCard.getByRole("textbox", { name: `${cardName}, English (en)` });
    await expect(box).toHaveValue(/Example text, to be replaced by the research team/);
    await box.fill(text);
    // The Finnish text of the seed carries the example marker as well.
    const finnish = textCard.getByRole("textbox", { name: `${cardName}, Finnish (fi)` });
    await expect(finnish).toHaveValue(/Esimerkkiteksti, jonka tutkimusryhmä korvaa/);
    await finnish.fill(`${text} (fi)`);
    await textCard.getByRole("button", { name: "Save", exact: true }).click();
    await expect(textCard.getByRole("button", { name: `Edit ${cardName}` })).toBeVisible();
    await expect(textCard).toContainText(text.split("\n")[0]!);
  }
  const welcome = content.getByRole("region", { name: "Welcome text" }).first();
  await expect(welcome).toContainText(WELCOME_ADDITION);

  // A consent version without example text. A published consent version never
  // changes, so a new one is published (through the API) and selected here.
  const consentVersion = await publishConsentWithoutExampleText(page.context().request);
  await page.reload();
  await openDraft(page);
  const consent = content.getByRole("region", { name: "Consent version" });
  await consent.getByRole("button", { name: "Edit Consent version" }).click();
  const option = consent.getByLabel("Published consent version").locator("option", { hasText: `Consent v${consentVersion}:` });
  await consent.getByLabel("Published consent version").selectOption((await option.getAttribute("value")) ?? "");
  await consent.getByRole("button", { name: "Save", exact: true }).click();
  await expect(consent.getByRole("button", { name: "Edit Consent version" })).toBeVisible();
  await expect(consent).toContainText(`Consent v${consentVersion}:`);

  // Task prompt.
  await content.getByRole("button", { name: "Edit task 1" }).click();
  const form = content.getByRole("form", { name: "Edit task controlled_invitation" });
  await expect(form.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue(OLD_PROMPT);
  await form.getByRole("textbox", { name: "Prompt", exact: true }).fill(NEW_PROMPT);
  await form.getByRole("button", { name: "Save task" }).click();
  await expect(form).toBeHidden();
  await expect(controlledTasks(page).first()).toContainText(PROMPT_ADDITION);

  // A predefined follow-up for task 2.
  await content.getByRole("button", { name: "Add follow-up to task 2" }).click();
  await content.getByRole("textbox", { name: "New follow-up text" }).fill(FOLLOWUP_TEXT);
  await content.getByRole("button", { name: "Add follow-up", exact: true }).click();
  await expect(content.getByRole("button", { name: "Edit follow-up 2.1" })).toBeVisible();
  await expect(controlledTasks(page).nth(1)).toContainText(FOLLOWUP_TEXT);

  // Move task 1 down and up again with the buttons.
  await expect(controlledTasks(page).first()).toContainText("controlled_invitation");
  await content.getByRole("button", { name: "Move task 1 down" }).click();
  await expect(controlledTasks(page).first()).toContainText("controlled_unexpected");
  await expect(controlledTasks(page).nth(1)).toContainText("controlled_invitation");
  await content.getByRole("button", { name: "Move task 2 up" }).click();
  await expect(controlledTasks(page).first()).toContainText("controlled_invitation");
  await expect(controlledTasks(page).nth(1)).toContainText("controlled_unexpected");

  // Everything is stored: a reload shows the same draft.
  await page.reload();
  const reloaded = await openDraft(page);
  await expect(reloaded.getByRole("region", { name: "Welcome text" }).first()).toContainText(WELCOME_ADDITION);
  await expect(controlledTasks(page).first()).toContainText(PROMPT_ADDITION);
  await expect(controlledTasks(page).nth(1)).toContainText(FOLLOWUP_TEXT);
});

test("the preview shows the draft with the PREVIEW banner and the edited texts", async ({ page }) => {
  const sessionsBefore = (await testSessions(page.context().request)).length;
  await openDraft(page);
  const opened = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Preview participant study (v2)" }).click();
  const preview = await opened;

  await expect(preview.getByRole("region", { name: "Preview" })).toContainText("PREVIEW");
  await expect(preview.getByRole("region", { name: "Preview" })).toContainText("NOT RESEARCH DATA");
  await expect(preview.getByRole("region", { name: "Preview" })).toContainText("Protocol v2 (draft)");
  // The preview opens in the default language of the study (Finnish). The texts edited above are the English ones.
  await preview.getByRole("button", { name: "English" }).click();
  await expect(preview.getByRole("main")).toContainText(WELCOME_ADDITION);

  // No participant API call leaves the preview while stepping through it.
  const studyCalls: string[] = [];
  preview.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/study/")) studyCalls.push(`${request.method()} ${request.url()}`);
  });
  const controls = preview.getByRole("navigation", { name: "Preview controls" });
  await controls.getByLabel("Go to step").selectOption({ label: "6. Task 1: An invitation" });
  await expect(preview.getByRole("main")).toContainText(NEW_PROMPT);
  await controls.getByRole("button", { name: "Next step" }).click();
  await controls.getByRole("button", { name: "Next step" }).click();
  await expect(preview.getByRole("main")).toContainText(FOLLOWUP_TEXT);
  expect(studyCalls).toEqual([]);
  await preview.close();

  // The preview created no session.
  expect((await testSessions(page.context().request)).length).toBe(sessionsBefore);
});

test("publishing shows the check and the differences, and makes v2 the current protocol", async ({ page }) => {
  await openDraft(page);
  await page.getByRole("region", { name: "Protocol status" }).getByRole("button", { name: "Publish draft" }).click();

  const review = page.getByRole("region", { name: "Review before publishing Protocol v2" });
  const check = review.getByRole("region", { name: "Publish check" });
  await expect(check.getByText("No blocking problems.", { exact: false })).toBeVisible();
  const differences = review.getByRole("region", { name: "Differences" });
  await expect(differences.getByRole("heading", { name: "2. Differences against the published Protocol v1" })).toBeVisible();
  // Old and new prompt text, the welcome text and the new follow-up are all named.
  await expect(differences).toContainText("Imagine an English-speaking friend has invited you somewhere this weekend.");
  await expect(differences).toContainText(PROMPT_ADDITION);
  await expect(differences).toContainText(WELCOME_ADDITION);
  // The example text of the published version is shown as what goes away.
  await expect(differences).toContainText("Example text, to be replaced by the research team");
  await expect(differences).toContainText(FOLLOWUP_TEXT);

  await review.getByRole("button", { name: "Publish Protocol v2" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish Protocol v2?" });
  await expect(dialog).toContainText("immutable");
  await dialog.getByRole("button", { name: "Publish Protocol v2" }).click();
  await expect(dialog).toBeHidden();

  const status = page.getByRole("region", { name: "Protocol status" });
  await expect(status).toContainText(/Published:\s*Protocol v2/);
  const versions = page.getByRole("table", { name: "Protocol versions, newest first" });
  await expect(versions.getByRole("row").filter({ hasText: "Protocol v2" })).toContainText("Current for new sessions");
  await expect(versions.getByRole("row").filter({ hasText: "Protocol v1" })).not.toContainText("Current for new sessions");
  // The published version has no edit control any more.
  await expect(page.getByRole("button", { name: "Edit Protocol v2" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View Protocol v2" })).toBeVisible();

  // The Dashboard names the new protocol.
  await openAdminPage(page, "/admin", "Dashboard");
  await expect(page.getByRole("region", { name: "Status" })).toContainText(/v2 Initial study flow/);
});

test("a new TEST session is pinned to v2, and an older session still shows the v1 prompt", async ({ page }) => {
  await openAdminPage(page, "/admin/sessions", "Sessions");
  const request = page.context().request;
  const samples = await sampleSessions(request);
  const sessionsBefore = (await testSessions(request)).length;
  await sendJson(request, "POST", "/api/study/sessions", { mode: "test", locale: "en" });

  const sessions = await testSessions(request);
  expect(sessions.length).toBe(sessionsBefore + 1);
  const created = sessions[sessions.length - 1]!;
  expect(created.protocolVersionNumber).toBe(2);
  for (const sample of samples) expect(sample.protocolVersionNumber).toBe(1);

  // The list shows the pinned version of each session.
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(`^${created.participantCode} `) })).toContainText("Protocol v2");
  const old = samples[0]!;
  await expect(page.getByRole("button", { name: new RegExp(`^${old.participantCode} `) })).toContainText("Protocol v1");

  // The older session keeps the exact text its participant saw.
  await page.getByRole("button", { name: new RegExp(`^${old.participantCode} `) }).click();
  const utterances = page.getByRole("region", { name: "4. Utterances" });
  const invitation = utterances.getByRole("article").filter({ hasText: "An invitation" });
  await expect(invitation.getByRole("blockquote")).toHaveText(OLD_PROMPT);
  await expect(utterances).not.toContainText(PROMPT_ADDITION);
});
