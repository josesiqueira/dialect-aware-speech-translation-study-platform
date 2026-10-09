import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminAuditLog,
  mediaAssets,
  processingBatches,
  sessions,
  studies,
  translations,
  utterances,
} from "@dialect/db";
import { insertSessionWithUtterance, type CollectedSession } from "@dialect/db/testing-builders";
import { corpusSchemas } from "@dialect/domain";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { seedDevelopmentData } from "@dialect/db/seed";
import { addNote, setSessionFlag } from "./curation";
import { getDashboard } from "./dashboard";
import {
  getMigrationStatus,
  getSettings,
  resetTestData,
  testProviderConnectivity,
  updateSettings,
  type ProviderClient,
} from "./settings";
import { processUtterance } from "./test-helpers";

let t: TestServiceContext;
let research: CollectedSession;
let studyId: string;

async function lastAudit(action: string) {
  const [row] = await t.ctx.db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.action, action))
    .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
    .limit(1);
  return row;
}

async function collect(mode: "research" | "demo" | "test", code: string): Promise<CollectedSession> {
  const key = `studies/test/${code}.wav`;
  await t.storage.put({ key, body: Buffer.from(code), contentType: "audio/wav" });
  return insertSessionWithUtterance(t.ctx.db, {
    studyId: research?.study.id,
    protocolVersionId: research?.protocol.id,
    session: { mode, participantCode: code, status: "completed" },
    media: { storageDriver: "memory", storageKey: key },
  });
}

beforeAll(async () => {
  t = await createTestServiceContext();
  research = await collect("research", "P-RESEARCH");
  studyId = research.study.id;
});

afterAll(async () => {
  await t.cleanup();
});

describe("getSettings", () => {
  it("returns the operational state, limits, technical status and application info", async () => {
    const settings = await getSettings(t.adminCtx, studyId, {
      environment: "test",
      storageLocation: "./data/media",
    });
    expect(settings.operational).toEqual({
      status: "active",
      // Not set in the study settings means closed.
      allowNewSessions: false,
      maintenanceMode: false,
      maintenanceMessage: null,
    });
    expect(settings.limits.maxUploadMb).toBeGreaterThan(0);
    expect(settings.limits.maxUtteranceSeconds).toBeGreaterThan(0);
    expect(settings.limits.sessionInactivityTimeoutMinutes).toBeGreaterThan(0);
    expect(settings.adminTimezone).toBe("UTC");
    expect(settings.database.connected).toBe(true);
    expect(settings.database.migrations).toMatchObject({ status: "up_to_date", pending: [], detail: null });
    expect(settings.database.migrations.applied).toBe(settings.database.migrations.expected);
    expect(settings.database.migrations.latestApplied).toMatch(/^\d{4}_/);
    expect(settings.storage).toMatchObject({ driver: "memory", location: "./data/media", connected: true, detail: null });
    expect(typeof settings.storage.ffmpeg.available).toBe("boolean");
    expect(settings.provider).toMatchObject({ openaiConfigured: false, lastTest: null });
    expect(settings.provider.providers).toEqual([
      { name: "openai", configured: false },
      { name: "mock", configured: true },
    ]);
    expect(settings.application).toMatchObject({ appVersion: "test", gitCommitSha: null, environment: "test" });
    expect(settings.application.worker.healthy).toBe(false);
    expect(settings.testDataReset).toEqual({
      allowed: true,
      phrase: corpusSchemas.TEST_DATA_RESET_PHRASE,
      counts: { demoSessions: 0, testSessions: 0 },
    });
  });

  it("reports pending migrations when the journal has an entry that is not applied", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const directory = await mkdtemp(path.join(tmpdir(), "journal-"));
    const file = path.join(directory, "_journal.json");
    await writeFile(file, JSON.stringify({ entries: [{ idx: 0, when: 1, tag: "9999_not_applied" }] }));
    const status = await getMigrationStatus(t.adminCtx, file);
    expect(status).toMatchObject({ status: "pending", pending: ["9999_not_applied"], expected: 1 });
    expect(status.detail).toContain("not in the journal");

    const missing = await getMigrationStatus(t.adminCtx, path.join(directory, "missing.json"));
    expect(missing.status).toBe("unknown");
  });

  it("disables the test data reset in production unless it is allowed explicitly", async () => {
    expect((await getSettings(t.adminCtx, studyId, { environment: "production" })).testDataReset.allowed).toBe(false);
    expect(
      (await getSettings(t.adminCtx, studyId, { environment: "production", allowTestDataResetInProduction: true }))
        .testDataReset.allowed,
    ).toBe(true);
  });
});

describe("updateSettings", () => {
  it("merges the changes, keeps other settings and writes an audit row with before and after", async () => {
    await t.ctx.db
      .update(studies)
      .set({ settingsJson: { participantLocales: ["fi", "en"], maxUploadMb: 50 } })
      .where(eq(studies.id, studyId));
    const updated = await updateSettings(t.adminCtx, studyId, {
      status: "paused",
      allowNewSessions: false,
      maintenanceMessage: "  Back on Monday.  ",
      maxUploadMb: 80,
      sessionInactivityTimeoutMinutes: 90,
      adminTimezone: "Europe/Helsinki",
    });
    expect(updated.operational).toEqual({
      status: "paused",
      allowNewSessions: false,
      maintenanceMode: false,
      maintenanceMessage: "Back on Monday.",
    });
    expect(updated.limits).toMatchObject({ maxUploadMb: 80, sessionInactivityTimeoutMinutes: 90 });
    expect(updated.adminTimezone).toBe("Europe/Helsinki");

    const [study] = await t.ctx.db.select().from(studies).where(eq(studies.id, studyId));
    expect(study?.status).toBe("paused");
    expect(study?.settingsJson).toEqual({
      participantLocales: ["fi", "en"],
      maxUploadMb: 80,
      allowNewSessions: false,
      maintenanceMessage: "Back on Monday.",
      sessionInactivityTimeoutMinutes: 90,
      adminTimezone: "Europe/Helsinki",
    });

    const audit = await lastAudit("settings.update");
    expect(audit).toMatchObject({
      entityType: "study",
      entityId: studyId,
      actorLabel: "admin",
      beforeJson: {
        status: "active",
        allowNewSessions: null,
        maintenanceMessage: null,
        maxUploadMb: 50,
        sessionInactivityTimeoutMinutes: null,
        adminTimezone: null,
      },
      afterJson: {
        status: "paused",
        allowNewSessions: false,
        maintenanceMessage: "Back on Monday.",
        maxUploadMb: 80,
        sessionInactivityTimeoutMinutes: 90,
        adminTimezone: "Europe/Helsinki",
      },
    });
  });

  it("writes nothing when no value changes", async () => {
    const before = await t.ctx.db.select().from(adminAuditLog);
    await updateSettings(t.adminCtx, studyId, { maxUploadMb: 80, status: "paused" });
    expect(await t.ctx.db.select().from(adminAuditLog)).toHaveLength(before.length);
    await updateSettings(t.adminCtx, studyId, { status: "active", allowNewSessions: true });
  });

  it("validates every field", async () => {
    const invalid: unknown[] = [
      {},
      { maxUploadMb: 0 },
      { maxUploadMb: 12.5 },
      { maxUtteranceSeconds: 2 },
      { sessionInactivityTimeoutMinutes: -1 },
      { adminTimezone: "Mars/Olympus" },
      { status: "deleted" },
      { allowNewSessions: "yes" },
      { maintenanceMessage: "x".repeat(1001) },
      { unknownSetting: true },
      { lastProviderTest: { at: "now", ok: true } },
    ];
    for (const changes of invalid) {
      await expect(updateSettings(t.adminCtx, studyId, changes as corpusSchemas.SettingsUpdate)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    await expect(
      updateSettings(t.adminCtx, "00000000-0000-4000-8000-000000000000", { maxUploadMb: 10 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stores the languages, the interface languages and the demo limit, with an audit row", async () => {
    await t.ctx.db.update(studies).set({ settingsJson: {} }).where(eq(studies.id, studyId));
    // Nothing is set: the view shows that, without an invented value.
    expect((await getSettings(t.adminCtx, studyId)).languages).toEqual({
      sourceLanguage: null,
      targetLanguage: null,
      participantLocales: [],
      defaultLocale: null,
      interfaceLocales: ["en", "fi"],
    });
    expect((await getSettings(t.adminCtx, studyId)).limits.demoDailyRunLimit).toBe(200);

    const updated = await updateSettings(t.adminCtx, studyId, {
      sourceLanguage: "fi",
      targetLanguage: "en-GB",
      participantLocales: ["fi", "en"],
      defaultLocale: "fi",
      demoDailyRunLimit: 50,
    });
    expect(updated.languages).toMatchObject({
      sourceLanguage: "fi",
      targetLanguage: "en-GB",
      participantLocales: ["fi", "en"],
      defaultLocale: "fi",
    });
    expect(updated.limits.demoDailyRunLimit).toBe(50);
    const [study] = await t.ctx.db.select().from(studies).where(eq(studies.id, studyId));
    expect(study?.settingsJson).toEqual({
      sourceLanguage: "fi",
      targetLanguage: "en-GB",
      participantLocales: ["fi", "en"],
      defaultLocale: "fi",
      demoDailyRunLimit: 50,
    });
    expect(await lastAudit("settings.update")).toMatchObject({
      beforeJson: { sourceLanguage: null, participantLocales: null, demoDailyRunLimit: null },
      afterJson: { sourceLanguage: "fi", targetLanguage: "en-GB", participantLocales: ["fi", "en"], demoDailyRunLimit: 50 },
    });

    // Saving the same list again changes nothing.
    const auditCount = (await t.ctx.db.select().from(adminAuditLog)).length;
    await updateSettings(t.adminCtx, studyId, { participantLocales: ["fi", "en"] });
    expect(await t.ctx.db.select().from(adminAuditLog)).toHaveLength(auditCount);
  });

  it("refuses languages the interface does not have, malformed tags and a default outside the offered languages", async () => {
    const invalid: unknown[] = [
      { sourceLanguage: "Finnish" },
      { sourceLanguage: "" },
      { targetLanguage: "e" },
      { participantLocales: [] },
      { participantLocales: ["fi", "sv"] },
      { participantLocales: ["fi", "fi"] },
      { defaultLocale: "sv" },
      { demoDailyRunLimit: 0 },
      { demoDailyRunLimit: 1.5 },
      { studyName: "   " },
      { participantTitle: "x".repeat(121) },
    ];
    for (const changes of invalid) {
      await expect(updateSettings(t.adminCtx, studyId, changes as corpusSchemas.SettingsUpdate)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    await updateSettings(t.adminCtx, studyId, { participantLocales: ["fi", "en"], defaultLocale: "fi" });
    // The default must stay among the offered languages, whichever of the two settings changes.
    await expect(updateSettings(t.adminCtx, studyId, { participantLocales: ["en"] })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      updateSettings(t.adminCtx, studyId, { participantLocales: ["en"], defaultLocale: "en" }),
    ).resolves.toMatchObject({ languages: { participantLocales: ["en"], defaultLocale: "en" } });
  });

  it("keeps the internal study name and the participant-facing title apart, both audited", async () => {
    const updated = await updateSettings(t.adminCtx, studyId, {
      studyName: "Dialect-Aware Speech Translation Study",
      participantTitle: "  Speech and translation study  ",
    });
    expect(updated.study).toMatchObject({
      name: "Dialect-Aware Speech Translation Study",
      participantTitle: "Speech and translation study",
      effectiveParticipantTitle: "Speech and translation study",
      participantTitleWarnings: [],
    });
    const [study] = await t.ctx.db.select().from(studies).where(eq(studies.id, studyId));
    expect(study?.name).toBe("Dialect-Aware Speech Translation Study");
    expect((study?.settingsJson as { participantTitle?: string }).participantTitle).toBe("Speech and translation study");
    expect(await lastAudit("settings.update")).toMatchObject({
      beforeJson: { studyName: "Test study", participantTitle: null },
      afterJson: {
        studyName: "Dialect-Aware Speech Translation Study",
        participantTitle: "Speech and translation study",
      },
    });

    // A priming term in the title is saved, and the view carries a warning that names the term.
    const primed = await updateSettings(t.adminCtx, studyId, { participantTitle: "Finnish dialect study" });
    expect(primed.study.participantTitle).toBe("Finnish dialect study");
    expect(primed.study.participantTitleWarnings).toHaveLength(1);
    expect(primed.study.participantTitleWarnings[0]).toContain('found "dialect"');

    // Without a title participants see the neutral standard title, never the internal name.
    const cleared = await updateSettings(t.adminCtx, studyId, { participantTitle: "" });
    expect(cleared.study).toMatchObject({
      participantTitle: null,
      effectiveParticipantTitle: "Research study",
      participantTitleWarnings: [],
    });
  });

  it("reports example text in the current protocol on Settings and on the Dashboard", async () => {
    const clean = await getSettings(t.adminCtx, studyId);
    expect(clean.exampleText).toEqual({ present: false, protocolVersionNumber: 1, fields: [], message: null });

    const seeded = await seedDevelopmentData(t.ctx.db);
    const settings = await getSettings(t.adminCtx, seeded.studyId);
    expect(settings.operational.allowNewSessions).toBe(false);
    expect(settings.exampleText.present).toBe(true);
    expect(settings.exampleText.message).toBe(
      "The current protocol still contains example text; research sessions are disabled until it is replaced.",
    );
    expect(settings.exampleText.fields).toContain("The welcome text");
    const dashboard = await getDashboard(t.adminCtx, seeded.studyId);
    expect(dashboard.status.exampleText).toMatchObject({ present: true, message: settings.exampleText.message });
    expect(dashboard.study.acceptingNewSessions).toBe(false);
  });
});

describe("testProviderConnectivity", () => {
  it("answers 'not configured' without a client and stores nothing", async () => {
    const result = await testProviderConnectivity(t.adminCtx, studyId, { client: null });
    expect(result).toMatchObject({ configured: false, ok: false, at: null });
    expect((await getSettings(t.adminCtx, studyId)).provider.lastTest).toBeNull();
  });

  it("runs the test with the given client and stores the result", async () => {
    let calls = 0;
    const client = {
      models: {
        list: async () => {
          calls += 1;
          return { data: [] };
        },
      },
    } as unknown as ProviderClient;
    const result = await testProviderConnectivity(t.adminCtx, studyId, { client });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ configured: true, ok: true, at: t.clock.now().toISOString() });
    expect((await getSettings(t.adminCtx, studyId)).provider.lastTest).toEqual({
      at: t.clock.now().toISOString(),
      ok: true,
      message: result.message,
    });
    // Reading the settings does not call the provider.
    await getSettings(t.adminCtx, studyId);
    expect(calls).toBe(1);

    const failing = {
      apiKey: "sk-secret-value-that-must-not-leak",
      models: {
        list: async () => {
          throw new Error("connect ECONNREFUSED sk-secret-value-that-must-not-leak");
        },
      },
    } as unknown as ProviderClient;
    const failed = await testProviderConnectivity(t.adminCtx, studyId, { client: failing });
    expect(failed).toMatchObject({ configured: true, ok: false });
    expect(JSON.stringify(failed)).not.toContain("sk-secret-value");
    expect((await getSettings(t.adminCtx, studyId)).provider.lastTest?.ok).toBe(false);
  });
});

describe("resetTestData", () => {
  const input = () => ({
    studyId,
    modes: ["demo", "test"] as corpusSchemas.ResettableMode[],
    confirmationPhrase: corpusSchemas.TEST_DATA_RESET_PHRASE,
    isProduction: false,
    allowInProduction: false,
  });

  it("requires the typed phrase and refuses in production unless allowed", async () => {
    const test = await collect("test", "P-TESTKEEP");
    await expect(resetTestData(t.adminCtx, { ...input(), confirmationPhrase: "delete test data" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(resetTestData(t.adminCtx, { ...input(), confirmationPhrase: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(resetTestData(t.adminCtx, { ...input(), isProduction: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      resetTestData(t.adminCtx, { ...input(), modes: ["research"] as unknown as corpusSchemas.ResettableMode[] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(resetTestData(t.adminCtx, { ...input(), modes: [] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const [row] = await t.ctx.db.select().from(sessions).where(eq(sessions.id, test.session.id));
    expect(row).toBeDefined();
    expect(await t.storage.exists(test.media.storageKey)).toBe(true);
  });

  it("removes demo and test data with their files and never research data", async () => {
    const ai = (await processUtterance(t.ctx.db, { studyId, utteranceId: research.utterance.id, batchNames: ["research-batch"] })).ai;
    const demo = await collect("demo", "P-DEMOGONE");
    const test = await collect("test", "P-TESTGONE");
    await processUtterance(t.ctx.db, { studyId, utteranceId: test.utterance.id, ai, batchNames: ["test-batch"], dataMode: "test" });
    await setSessionFlag(t.adminCtx, { sessionId: test.session.id, flagged: true, notes: "test flag" });
    await addNote(t.adminCtx, { entityType: "session", entityId: research.session.id, body: "research note" });

    const researchTranslations = (await t.ctx.db.select().from(translations)).filter(
      (row) => row.translatedText.startsWith("research-batch"),
    );
    expect(researchTranslations).toHaveLength(6);

    const result = await resetTestData(t.adminCtx, { ...input(), isProduction: true, allowInProduction: true });
    expect(result.modes).toEqual(["demo", "test"]);
    expect(result.deleted.sessions).toBe(3);
    expect(result.deleted.translations).toBe(6);
    expect(result.storageObjectsFailed).toBeGreaterThanOrEqual(0);

    // Demo and test rows and files are gone.
    const remaining = await t.ctx.db.select().from(sessions);
    expect(remaining.map((row) => row.mode)).toEqual(["research"]);
    expect(await t.storage.exists(demo.media.storageKey)).toBe(false);
    expect(await t.storage.exists(test.media.storageKey)).toBe(false);
    expect((await t.ctx.db.select().from(processingBatches)).map((batch) => batch.name)).toEqual(["research-batch"]);

    // Research data is untouched: session, utterance, recording, file, outputs, notes.
    const [session] = await t.ctx.db.select().from(sessions).where(eq(sessions.id, research.session.id));
    const [utterance] = await t.ctx.db.select().from(utterances).where(eq(utterances.id, research.utterance.id));
    const [media] = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, research.media.id));
    expect(session?.participantCode).toBe("P-RESEARCH");
    expect(utterance?.status).toBe("submitted");
    expect(media?.deletedAt).toBeNull();
    expect(await t.storage.exists(research.media.storageKey)).toBe(true);
    expect(await t.ctx.db.select().from(translations)).toHaveLength(6);
    const settings = await getSettings(t.adminCtx, studyId);
    expect(settings.testDataReset.counts).toEqual({ demoSessions: 0, testSessions: 0 });

    const audit = await lastAudit("test_data.reset");
    expect(audit).toMatchObject({
      entityType: "study",
      entityId: studyId,
      actorLabel: "admin",
      afterJson: { modes: ["demo", "test"], deleted: { sessions: 3 } },
    });
  });

  it("can reset one mode only", async () => {
    const demo = await collect("demo", "P-DEMOSTAY");
    const test = await collect("test", "P-TESTONLY");
    const result = await resetTestData(t.adminCtx, { ...input(), modes: ["test"] });
    expect(result.deleted.sessions).toBe(1);
    expect(await t.storage.exists(test.media.storageKey)).toBe(false);
    expect(await t.storage.exists(demo.media.storageKey)).toBe(true);
    const modes = (await t.ctx.db.select().from(sessions)).map((row) => row.mode).sort();
    expect(modes).toEqual(["demo", "research"]);
  });
});
