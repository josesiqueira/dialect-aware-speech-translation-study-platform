// Data & Export (spec 56, 57, 157.19 to 157.21, docs/EXPORT-SCHEMA.md): TEST data
// is left out unless it is ticked, tables download, and the full dataset package
// is built by the worker with a manifest whose hashes match the files.
import { createHash } from "node:crypto";
import { expect, test, type Download, type Page } from "@playwright/test";
import { completedTestCorpus, downloadBytes, getJson, openAdminPage, readZip, sampleSessions, type SessionListItem } from "./support/admin";

let samples: SessionListItem[];
// The completed TEST sessions: the three samples and the short sessions of the pipeline test.
let corpus: { sessions: SessionListItem[]; utterances: number };

test.beforeEach(async ({ page }) => {
  samples = await sampleSessions(page.context().request);
  corpus = await completedTestCorpus(page.context().request);
  expect(corpus.sessions.length).toBeGreaterThanOrEqual(3);
});

function selectedCounts(page: Page) {
  return page.getByRole("region", { name: "Export filters" }).getByTestId("export-preview");
}

async function downloadSessionsCsv(page: Page): Promise<{ download: Download; text: string }> {
  const started = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Sessions as CSV" }).click();
  const download = await started;
  return { download, text: (await downloadBytes(download)).toString("utf8") };
}

test("the default filters select no TEST session, and ticking TEST changes the counts", async ({ page }) => {
  await openAdminPage(page, "/admin/data", "Data & Export");
  const filters = page.getByRole("region", { name: "Export filters" });
  const selected = selectedCounts(page);

  await expect(filters.getByRole("checkbox", { name: "Research sessions" })).toBeChecked();
  await expect(filters.getByRole("checkbox", { name: /^Include TEST sessions/ })).not.toBeChecked();
  await expect(filters.getByRole("checkbox", { name: /^Include DEMO sessions/ })).not.toBeChecked();
  await expect(selected).toContainText("0 sessions");
  await expect(selected).toContainText("0 utterances");
  await expect(selected).toContainText("0 source recordings");

  await filters.getByRole("checkbox", { name: /^Include TEST sessions/ }).check();
  // The completed TEST sessions with their recordings.
  await expect(selected).toContainText(`${corpus.sessions.length} sessions`);
  await expect(selected).toContainText(`${corpus.utterances} utterances`);
  await expect(selected).toContainText(`${corpus.utterances} source recordings`);
  await expect(selected).toContainText(/[1-9]\d* translations/);

  await filters.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(filters.getByRole("checkbox", { name: /^Include TEST sessions/ })).not.toBeChecked();
  await expect(selected).toContainText("0 sessions");
});

test("sessions.csv contains the sample participant codes only when TEST is ticked", async ({ page }) => {
  await openAdminPage(page, "/admin/data", "Data & Export");
  const filters = page.getByRole("region", { name: "Export filters" });

  const withoutTest = await downloadSessionsCsv(page);
  expect(withoutTest.download.suggestedFilename()).toMatch(/sessions.*\.csv$/);
  const header = withoutTest.text.split(/\r?\n/)[0] ?? "";
  expect(header).toContain("participant_code");
  expect(header).toContain("session_id");
  for (const session of samples) expect(withoutTest.text).not.toContain(session.participantCode);
  // No research session exists: the file is the header line only.
  expect(withoutTest.text.trim().split(/\r?\n/)).toHaveLength(1);

  await filters.getByRole("checkbox", { name: /^Include TEST sessions/ }).check();
  await expect(selectedCounts(page)).toContainText(`${corpus.sessions.length} sessions`);
  const withTest = await downloadSessionsCsv(page);
  for (const session of samples) expect(withTest.text).toContain(session.participantCode);
  expect(withTest.text.trim().split(/\r?\n/)).toHaveLength(1 + corpus.sessions.length);
  // Every exported row says that it is test data.
  const modeColumn = header.split(",").indexOf("mode");
  if (modeColumn >= 0) {
    for (const line of withTest.text.trim().split(/\r?\n/).slice(1)) expect(line).toContain("test");
  }
});

type Manifest = {
  export_type: string;
  filters: Record<string, unknown>;
  counts: { sessions: number; utterances: number; source_audio_files: number; generated_audio_files: number };
  files: Array<{ path: string; size_bytes: number; sha256: string; kind?: string; database_sha256?: string }>;
};

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Ticks "Include TEST sessions", clicks the button that creates an export job,
 * waits until the worker has ended the job, downloads the archive from "Recent
 * exports" and returns its files and its manifest.
 */
async function createAndDownloadArchive(page: Page, cardName: string, buttonName: RegExp | string) {
  await openAdminPage(page, "/admin/data", "Data & Export");
  const filters = page.getByRole("region", { name: "Export filters" });
  await filters.getByRole("checkbox", { name: /^Include TEST sessions/ }).check();
  await expect(selectedCounts(page)).toContainText(`${corpus.sessions.length} sessions`);

  const card = page.getByRole("region", { name: cardName, exact: true });
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin/export/jobs",
  );
  await card.getByRole("button", { name: buttonName }).click();
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(200);
  const jobId = ((await createdResponse.json()) as { job: { id: string } }).job.id;

  // The worker builds the archive. Wait until the job has ended, then refresh the list.
  type Job = { id: string; status: string; errorMessage: string | null };
  const jobState = async () => {
    const list = await getJson<{ items: Job[] }>(page.context().request, "/api/admin/export/jobs");
    return list.items.find((job) => job.id === jobId);
  };
  await expect
    .poll(async () => (await jobState())?.status, { timeout: 90_000, intervals: [1_000], message: "the export job ends" })
    .toMatch(/^(completed|failed)$/);
  const finished = await jobState();
  expect(finished?.status, `export job: ${finished?.errorMessage ?? "no error message"}`).toBe("completed");

  const exportsCard = page.getByRole("region", { name: "Recent exports" });
  await exportsCard.getByRole("button", { name: "Refresh" }).click();
  const downloadLink = exportsCard.locator(`a[href*="${jobId}"]`);
  await expect(downloadLink).toBeVisible();
  const row = exportsCard.getByRole("row").filter({ has: page.locator(`a[href*="${jobId}"]`) });
  await expect(row).toContainText("Completed");

  const started = page.waitForEvent("download");
  await downloadLink.click();
  const download = await started;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const bytes = await downloadBytes(download);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  const zip = readZip(bytes);
  const names = [...zip.keys()].filter((name) => !name.endsWith("/"));
  expect(names).toContain("MANIFEST.json");
  const manifest = JSON.parse(zip.get("MANIFEST.json")!.data().toString("utf8")) as Manifest;
  return { zip, names, manifest, fileName: download.suggestedFilename() };
}

/**
 * The integrity check of the README of every package: each file named in the
 * manifest is in the archive with the stated size and SHA-256, and the archive
 * holds no file that the manifest does not name (except the manifest itself).
 */
function expectManifestMatchesFiles(archive: Awaited<ReturnType<typeof createAndDownloadArchive>>): void {
  const { zip, names, manifest } = archive;
  expect(manifest.files.length).toBeGreaterThan(0);
  for (const entry of manifest.files) {
    const file = zip.get(entry.path);
    expect(file, `${entry.path} is in the archive`).toBeTruthy();
    const data = file!.data();
    expect(data.length, `size of ${entry.path}`).toBe(entry.size_bytes);
    expect(sha256(data), `SHA-256 of ${entry.path}`).toBe(entry.sha256);
    // For audio the manifest also gives the hash recorded when the file was first stored.
    if (entry.database_sha256 !== undefined) expect(entry.database_sha256).toBe(entry.sha256);
  }
  expect([...names].sort()).toEqual([...manifest.files.map((file) => file.path), "MANIFEST.json"].sort());
}

test("the full dataset package with TEST data is built by the worker and its manifest matches the files", async ({ page }) => {
  test.setTimeout(240_000);
  await openAdminPage(page, "/admin/data", "Data & Export");
  await expect(
    page.getByRole("region", { name: "Full dataset package" }).getByRole("checkbox", { name: "Include source recordings" }),
  ).toBeChecked();
  const archive = await createAndDownloadArchive(page, "Full dataset package", /^Create .*dataset package$/);
  const { zip, names, manifest } = archive;

  for (const required of ["MANIFEST.json", "data_dictionary.md", "sessions.csv", "utterances.csv", "README.md"]) {
    expect(names, `${required} in the package`).toContain(required);
  }
  const sourceFiles = names.filter((name) => name.startsWith("source_audio/") && !name.endsWith("/"));
  expect(sourceFiles).toHaveLength(corpus.utterances);
  // Pseudonymous names. The sample recordings are WAV; a browser recording of the participant spec can be WebM.
  for (const name of sourceFiles) expect(name).toMatch(/^source_audio\/P-[A-Z0-9]+_U-\d{2}_source\.[a-z0-9]+$/);
  for (const session of samples) {
    expect(sourceFiles).toContain(`source_audio/${session.participantCode}_U-01_source.wav`);
  }
  expect(names.some((name) => name.startsWith("generated_audio/"))).toBe(true);

  const sessionsCsv = zip.get("sessions.csv")!.data().toString("utf8");
  for (const session of samples) expect(sessionsCsv).toContain(session.participantCode);

  // The manifest names the filters, and the hash of every other file matches.
  expect(manifest.export_type).toBe("dataset_package");
  expect(JSON.stringify(manifest.filters)).toContain("test");
  expect(manifest.counts.sessions).toBe(corpus.sessions.length);
  expect(manifest.counts.source_audio_files).toBe(corpus.utterances);
  expectManifestMatchesFiles(archive);
});

test("the source recordings ZIP holds every selected recording and utterances.csv, and its manifest matches", async ({ page }) => {
  test.setTimeout(240_000);
  const archive = await createAndDownloadArchive(page, "Audio", "Create source recordings ZIP");
  const { names, manifest, fileName } = archive;
  expect(fileName).toMatch(/^source-audio-.*\.zip$/);
  expect(manifest.export_type).toBe("source_audio_zip");

  const sourceFiles = names.filter((name) => name.startsWith("source_audio/"));
  expect(sourceFiles).toHaveLength(corpus.utterances);
  for (const name of sourceFiles) expect(name).toMatch(/^source_audio\/P-[A-Z0-9]+_U-\d{2}_source\.[a-z0-9]+$/);
  for (const session of samples) expect(sourceFiles).toContain(`source_audio/${session.participantCode}_U-01_source.wav`);
  // Only the recordings, their table, the README and the manifest.
  expect(names).toContain("utterances.csv");
  expect(names).toContain("README.md");
  expect(names.some((name) => name.startsWith("generated_audio/"))).toBe(false);
  expect(names).not.toContain("sessions.csv");
  expect(manifest.counts.source_audio_files).toBe(corpus.utterances);
  expect(manifest.counts.generated_audio_files).toBe(0);
  expect(manifest.files.filter((file) => file.kind === "source_audio")).toHaveLength(corpus.utterances);
  expectManifestMatchesFiles(archive);
});

test("the generated speech ZIP holds the TTS files and syntheses.csv, and its manifest matches", async ({ page }) => {
  test.setTimeout(240_000);
  const archive = await createAndDownloadArchive(page, "Audio", "Create generated speech ZIP");
  const { zip, names, manifest, fileName } = archive;
  expect(fileName).toMatch(/^generated-audio-.*\.zip$/);
  expect(manifest.export_type).toBe("tts_audio_zip");

  const generated = names.filter((name) => name.startsWith("generated_audio/"));
  expect(generated.length).toBeGreaterThan(0);
  expect(manifest.counts.generated_audio_files).toBe(generated.length);
  expect(manifest.counts.source_audio_files).toBe(0);
  // Only the generated speech, its table, the README and the manifest.
  expect(names).toContain("syntheses.csv");
  expect(names).toContain("README.md");
  expect(names.some((name) => name.startsWith("source_audio/"))).toBe(false);
  // Each generated file is named in syntheses.csv, and each one is audio of some length.
  const synthesesCsv = zip.get("syntheses.csv")!.data().toString("utf8");
  for (const name of generated) {
    expect(synthesesCsv).toContain(name);
    expect(zip.get(name)!.data().length).toBeGreaterThan(44);
    expect(name).toMatch(/^generated_audio\/P-[A-Z0-9]+_U-\d{2}_/);
  }
  expectManifestMatchesFiles(archive);
});
