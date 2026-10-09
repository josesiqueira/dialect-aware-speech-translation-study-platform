import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mediaAssets,
  protocolTasks,
  questionnaireAnswers,
  questionnaireResponses,
  sessionConsents,
  sessions,
  studies,
  taskPresentations,
  utterances,
  type StudySettings,
} from "@dialect/db";
import {
  insertActiveAiConfigs,
  insertProcessingBatch,
  insertPublishedProtocol,
  insertStudy,
  insertTranscriptWithRevision,
  insertTranslation,
} from "@dialect/db/testing-builders";
import { AppError, protocolSchemas } from "@dialect/domain";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  acknowledgeInstructions,
  completeSession,
  confirmMicCheck,
  createSession,
  createUtterance,
  discardCandidate,
  getParticipantState,
  getPublicStudyInfo,
  getSessionByToken,
  hashSessionToken,
  markAbandonedSessions,
  recordConsent,
  SHUFFLE_ALGORITHM,
  skipTurn,
  startTask,
  submitQuestionnaire,
  submitUtterance,
  uploadUtteranceAudio,
  withdrawSession,
} from "./index";
import {
  acceptAll,
  answerAllTasks,
  answerCurrentTurn,
  createTestStudy,
  expectStep,
  sessionAtTasks,
  sineWav,
  updateSettings,
  VALID_BACKGROUND_ANSWERS,
  VALID_POST_ANSWERS,
} from "./test-support";

// The file runs many whole sessions: the 5 second default is too short under load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestServiceContext;

beforeAll(async () => {
  t = await createTestServiceContext();
});
afterAll(async () => {
  await t.cleanup();
});

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

const sessionRow = async (id: string) => (await t.ctx.db.select().from(sessions).where(eq(sessions.id, id)))[0]!;

describe("public study information and session creation", () => {
  it("describes an open study with the welcome text of the current protocol", async () => {
    const study = await createTestStudy(t.ctx.db, {
      settings: { participantLocales: ["fi", "en"], defaultLocale: "fi", studyLaptopMode: true },
    });
    const info = await getPublicStudyInfo(t.ctx, { studySlug: study.slug });
    expect(info).toEqual({
      // The neutral participant title, never the internal study name ("Test study").
      studyName: "Research study",
      acceptingNewSessions: true,
      closedReason: null,
      closedMessage: null,
      welcomeContent: "Test welcome text.",
      // The neutral title has a Finnish form. The welcome text has no translation: the base text in both.
      studyNameByLocale: { fi: "Tutkimus", en: "Research study" },
      welcomeContentByLocale: { fi: "Test welcome text.", en: "Test welcome text." },
      locales: ["fi", "en"],
      defaultLocale: "fi",
      studyLaptopMode: true,
    });
  });

  it("shows participants the participant title, never the internal study name", async () => {
    const study = await createTestStudy(t.ctx.db, {
      settings: { participantTitle: "Puhetutkimus" } as StudySettings,
    });
    await t.ctx.db.update(studies).set({ name: "Dialect translation study" }).where(eq(studies.id, study.study.id));
    const info = await getPublicStudyInfo(t.ctx, { studySlug: study.slug });
    expect(info.studyName).toBe("Puhetutkimus");
    const created = await createSession(t.ctx, { studySlug: study.slug });
    expect(created.state.studyName).toBe("Puhetutkimus");
    expect(JSON.stringify([info, created.state])).not.toContain("Dialect");
  });

  it("is closed, and has no session at all, when no setting opens it", async () => {
    // allowNewSessions not set means closed: collecting data is an explicit decision.
    const study = await insertStudy(t.ctx.db, { settingsJson: {} });
    await insertPublishedProtocol(t.ctx.db, { studyId: study.id });
    const info = await getPublicStudyInfo(t.ctx, { studySlug: study.slug });
    expect(info).toMatchObject({ acceptingNewSessions: false, closedReason: "new_sessions_disabled" });
    // Without configured locales the interface language is the neutral fallback.
    expect(info).toMatchObject({ locales: ["en"], defaultLocale: "en" });
    const error = await expectAppError(createSession(t.ctx, { studySlug: study.slug }), "STUDY_CLOSED");
    expect(error.details).toEqual({ reason: "new_sessions_disabled" });
  });

  it("refuses a research session while the current protocol contains example text, and allows test and demo sessions", async () => {
    const study = await insertStudy(t.ctx.db, { settingsJson: { allowNewSessions: true, demoPublic: true } });
    await insertPublishedProtocol(t.ctx.db, {
      studyId: study.id,
      welcomeContent: `${protocolSchemas.EXAMPLE_TEXT_NOTICE} Welcome.`,
    });
    const info = await getPublicStudyInfo(t.ctx, { studySlug: study.slug });
    expect(info).toMatchObject({
      acceptingNewSessions: false,
      closedReason: "example_text_present",
      closedMessage: "This study is not currently accepting new participants.",
    });
    const error = await expectAppError(createSession(t.ctx, { studySlug: study.slug }), "STUDY_CLOSED");
    expect(error.details).toEqual({ reason: "example_text_present" });
    expect(await t.ctx.db.select().from(sessions).where(eq(sessions.studyId, study.id))).toHaveLength(0);

    const test = await createSession(t.ctx, { studySlug: study.slug, mode: "test", callerIsAdmin: true });
    expect(test.session.mode).toBe("test");
    const demo = await createSession(t.ctx, { studySlug: study.slug, mode: "demo" });
    expect(demo.session.mode).toBe("demo");

    // The same protocol without example text accepts research sessions.
    const clean = await createTestStudy(t.ctx.db);
    expect((await getPublicStudyInfo(t.ctx, { studySlug: clean.slug })).closedReason).toBeNull();
    expect((await createSession(t.ctx, { studySlug: clean.slug })).session.mode).toBe("research");
  });

  it("refuses new sessions when the study is paused, closed, set to no new sessions, in maintenance or without a protocol", async () => {
    const study = await createTestStudy(t.ctx.db);
    const cases: Array<{ apply: () => Promise<unknown>; reason: string; message: string }> = [
      {
        apply: () => updateSettings(t.ctx.db, study.study.id, { allowNewSessions: false }),
        reason: "new_sessions_disabled",
        message: "This study is not currently accepting new participants.",
      },
      {
        apply: async () => {
          await updateSettings(t.ctx.db, study.study.id, { allowNewSessions: true });
          await t.ctx.db.update(studies).set({ status: "paused" }).where(eq(studies.id, study.study.id));
        },
        reason: "study_paused",
        message: "This study is not currently accepting new participants.",
      },
      {
        apply: () => t.ctx.db.update(studies).set({ status: "closed" }).where(eq(studies.id, study.study.id)),
        reason: "study_closed",
        message: "This study is not currently accepting new participants.",
      },
      {
        apply: async () => {
          await t.ctx.db.update(studies).set({ status: "active" }).where(eq(studies.id, study.study.id));
          await updateSettings(t.ctx.db, study.study.id, { maintenanceMode: true, maintenanceMessage: "Back at 14:00." });
        },
        reason: "maintenance",
        message: "Back at 14:00.",
      },
      {
        apply: async () => {
          await updateSettings(t.ctx.db, study.study.id, { maintenanceMode: false });
          await t.ctx.db.update(studies).set({ currentProtocolVersionId: null }).where(eq(studies.id, study.study.id));
        },
        reason: "no_protocol",
        message: "This study is not currently accepting new participants.",
      },
    ];
    for (const entry of cases) {
      await entry.apply();
      const info = await getPublicStudyInfo(t.ctx, { studySlug: study.slug });
      expect(info.acceptingNewSessions).toBe(false);
      expect(info.closedReason).toBe(entry.reason);
      expect(info.closedMessage).toBe(entry.message);
      const error = await expectAppError(createSession(t.ctx, { studySlug: study.slug }), "STUDY_CLOSED");
      expect(error.message).toBe(entry.message);
    }
    const rows = await t.ctx.db.select().from(sessions).where(eq(sessions.studyId, study.study.id));
    expect(rows).toHaveLength(0);
  });

  it("creates a research session pinned to the current protocol, with a random code and only the token hash stored", async () => {
    const study = await createTestStudy(t.ctx.db, { settings: { participantLocales: ["fi", "en"], defaultLocale: "fi" } });
    const created = await createSession(t.ctx, {
      studySlug: study.slug,
      locale: "en",
      browserInfo: { userAgent: "TestBrowser/1.0", language: "en" },
    });
    const row = await sessionRow(created.session.id);
    expect(row.mode).toBe("research");
    expect(row.status).toBe("created");
    expect(row.protocolVersionId).toBe(study.protocol.id);
    expect(row.participantCode).toMatch(/^P-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(row.tokenHash).toBe(hashSessionToken(created.token));
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(row.tokenExpiresAt?.getTime()).toBe(t.clock.now().getTime() + 24 * 3600 * 1000);
    expect(row.locale).toBe("en");
    expect(row.appVersion).toBe("test");
    expect(row.orderSeed).toMatch(/^[0-9a-f]{32}$/);
    expect(row.browserInfoJson).toEqual({ userAgent: "TestBrowser/1.0", language: "en" });
    expect(row.consentedAt).toBeNull();
    // No column holds a client address.
    expect(Object.keys(row).some((key) => /address|^ip/i.test(key))).toBe(false);

    const other = await createSession(t.ctx, { studySlug: study.slug, locale: "de" });
    expect(other.session.participantCode).not.toBe(row.participantCode);
    expect(other.session.orderSeed).not.toBe(row.orderSeed);
    // A locale the study does not offer falls back to the default.
    expect(other.session.locale).toBe("fi");
  });

  it("allows test and demo sessions only for an admin (demo also when the study opens it), and stores the mode", async () => {
    const study = await createTestStudy(t.ctx.db);
    await expectAppError(createSession(t.ctx, { studySlug: study.slug, mode: "test" }), "FORBIDDEN");
    await expectAppError(createSession(t.ctx, { studySlug: study.slug, mode: "demo" }), "FORBIDDEN");
    const test = await createSession(t.ctx, { studySlug: study.slug, mode: "test", callerIsAdmin: true });
    expect((await sessionRow(test.session.id)).mode).toBe("test");
    expect(test.state.mode).toBe("test");
    const demo = await createSession(t.ctx, { studySlug: study.slug, mode: "demo", callerIsAdmin: true });
    expect((await sessionRow(demo.session.id)).mode).toBe("demo");

    await updateSettings(t.ctx.db, study.study.id, { demoPublic: true });
    const publicDemo = await createSession(t.ctx, { studySlug: study.slug, mode: "demo" });
    expect(publicDemo.session.mode).toBe("demo");

    // A researcher can test while the study takes no new participants.
    await updateSettings(t.ctx.db, study.study.id, { allowNewSessions: false });
    await expectAppError(createSession(t.ctx, { studySlug: study.slug }), "STUDY_CLOSED");
    await expectAppError(createSession(t.ctx, { studySlug: study.slug, mode: "demo" }), "STUDY_CLOSED");
    const paused = await createSession(t.ctx, { studySlug: study.slug, mode: "test", callerIsAdmin: true });
    expect(paused.session.mode).toBe("test");
  });

  it("resolves a session by its token, records activity and rejects unknown and expired tokens", async () => {
    const study = await createTestStudy(t.ctx.db);
    const created = await createSession(t.ctx, { studySlug: study.slug });
    t.clock.advance(60_000);
    const found = await getSessionByToken(t.ctx, created.token);
    expect(found.id).toBe(created.session.id);
    expect(found.lastActivityAt.getTime()).toBe(t.clock.now().getTime());

    await expectAppError(getSessionByToken(t.ctx, "x".repeat(43)), "SESSION_EXPIRED");
    await expectAppError(getSessionByToken(t.ctx, null), "SESSION_EXPIRED");
    t.clock.advance(24 * 3600 * 1000);
    await expectAppError(getSessionByToken(t.ctx, created.token), "SESSION_EXPIRED");
  });
});

describe("consent", () => {
  it("shows the pinned consent version and stores the choices with text snapshots in one step", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session, state } = await createSession(t.ctx, { studySlug: study.slug });
    const consentState = expectStep(state, "consent");
    expect(consentState.information.content).toBe("Test information text.");
    expect(consentState.consent).toMatchObject({
      consentVersionId: study.consent.id,
      versionNumber: study.consent.versionNumber,
      title: "Consent to take part",
    });
    expect(consentState.consent.items).toEqual([
      { id: "participation", text: "I agree to take part in this study.", required: true },
      { id: "voice_recording", text: "I agree that my voice is recorded.", required: true },
      { id: "future_reuse", text: "My recordings may be reused in later research.", required: false },
    ]);

    t.clock.advance(5000);
    const next = await recordConsent(t.ctx, session, {
      responses: [
        { itemId: "participation", accepted: true },
        { itemId: "voice_recording", accepted: true },
        { itemId: "future_reuse", accepted: false },
      ],
    });
    expect(next.step).toBe("mic_check");
    const [row] = await t.ctx.db.select().from(sessionConsents).where(eq(sessionConsents.sessionId, session.id));
    expect(row!.consentVersionId).toBe(study.consent.id);
    expect(row!.acceptedAt.getTime()).toBe(t.clock.now().getTime());
    expect(row!.responsesJson).toEqual([
      { itemId: "participation", textSnapshot: "I agree to take part in this study.", required: true, accepted: true },
      { itemId: "voice_recording", textSnapshot: "I agree that my voice is recorded.", required: true, accepted: true },
      {
        itemId: "future_reuse",
        textSnapshot: "My recordings may be reused in later research.",
        required: false,
        accepted: false,
      },
    ]);
    const stored = await sessionRow(session.id);
    expect(stored.status).toBe("consented");
    expect(stored.consentedAt?.getTime()).toBe(t.clock.now().getTime());
  });

  it("stores nothing when a required item is refused, and the session stays at consent", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session } = await createSession(t.ctx, { studySlug: study.slug });
    const error = await expectAppError(
      recordConsent(t.ctx, session, {
        responses: [
          { itemId: "participation", accepted: true },
          { itemId: "voice_recording", accepted: false },
          { itemId: "future_reuse", accepted: true },
        ],
      }),
      "VALIDATION_ERROR",
    );
    expect(error.details).toEqual({ reason: "required_consent_not_accepted", itemIds: ["voice_recording"] });
    expect(await t.ctx.db.select().from(sessionConsents).where(eq(sessionConsents.sessionId, session.id))).toHaveLength(0);
    const stored = await sessionRow(session.id);
    expect(stored.status).toBe("created");
    expect(stored.consentedAt).toBeNull();
    expect((await getParticipantState(t.ctx, session)).step).toBe("consent");

    // The exit path: before consent the session is simply abandoned.
    const ended = await withdrawSession(t.ctx, session);
    expect(ended.step).toBe("withdrawn");
    const after = await sessionRow(session.id);
    expect(after.status).toBe("abandoned");
    expect(after.withdrawnAt).toBeNull();
    expect(after.abandonedAt).not.toBeNull();
  });

  it("removes the browser data of a session that is declined before consent", async () => {
    const study = await createTestStudy(t.ctx.db, { settings: { participantLocales: ["fi", "en"] } });
    const created = await createSession(t.ctx, {
      studySlug: study.slug,
      locale: "fi",
      browserInfo: { userAgent: "DeclineBrowser/1.0 (secret-user-agent)", platform: "TestOS", language: "fi-FI" },
    });
    const before = await sessionRow(created.session.id);
    expect(before.browserInfoJson).toMatchObject({ userAgent: "DeclineBrowser/1.0 (secret-user-agent)" });
    expect(before.locale).toBe("fi");

    // "I do not want to take part" on the consent page.
    await withdrawSession(t.ctx, created.session);
    const after = await sessionRow(created.session.id);
    expect(after.status).toBe("abandoned");
    // The page says that nothing was stored: no browser data stay in the row.
    expect(after.browserInfoJson).toBeNull();
    expect(after.audioEnvironmentJson).toBeNull();
    expect(after.locale).toBeNull();
    expect(after.tokenHash).toBeNull();
    expect(JSON.stringify(after)).not.toContain("secret-user-agent");
    await expectAppError(getSessionByToken(t.ctx, created.token), "SESSION_EXPIRED");

    // A withdrawal after consent keeps the session data: what happens to them is
    // decided by the protocol, not by this code.
    const consented = await createSession(t.ctx, { studySlug: study.slug, browserInfo: { userAgent: "KeptBrowser/1.0" } });
    await recordConsent(t.ctx, consented.session, { responses: acceptAll(consented.state) });
    await withdrawSession(t.ctx, consented.session);
    const kept = await sessionRow(consented.session.id);
    expect(kept.status).toBe("withdrawn");
    expect(kept.browserInfoJson).toMatchObject({ userAgent: "KeptBrowser/1.0" });
  });

  it("rejects missing, unknown and duplicate items", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session } = await createSession(t.ctx, { studySlug: study.slug });
    const missing = await expectAppError(
      recordConsent(t.ctx, session, { responses: [{ itemId: "participation", accepted: true }] }),
      "VALIDATION_ERROR",
    );
    expect(missing.details).toMatchObject({ reason: "consent_items_unanswered", itemIds: ["voice_recording", "future_reuse"] });
    await expectAppError(
      recordConsent(t.ctx, session, { responses: [{ itemId: "made_up", accepted: true }] }),
      "VALIDATION_ERROR",
    );
    await expectAppError(
      recordConsent(t.ctx, session, {
        responses: [
          { itemId: "participation", accepted: true },
          { itemId: "participation", accepted: true },
        ],
      }),
      "VALIDATION_ERROR",
    );
    expect(await t.ctx.db.select().from(sessionConsents).where(eq(sessionConsents.sessionId, session.id))).toHaveLength(0);
  });

  it("is safe to call twice, also at the same time: one row, the first choices kept", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session, state } = await createSession(t.ctx, { studySlug: study.slug });
    const responses = acceptAll(state);
    const results = await Promise.all([
      recordConsent(t.ctx, session, { responses }),
      recordConsent(t.ctx, session, { responses }),
    ]);
    expect(results.map((result) => result.step)).toEqual(["mic_check", "mic_check"]);
    await confirmMicCheck(t.ctx, session, {});
    const later = await recordConsent(t.ctx, session, {
      responses: responses.map((response) => ({ ...response, accepted: false })),
    });
    expect(later.step).toBe("instructions");
    const rows = await t.ctx.db.select().from(sessionConsents).where(eq(sessionConsents.sessionId, session.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.responsesJson.every((response) => response.accepted)).toBe(true);
  });

  it("is required before anything else: every later step rejects a session without consent", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session } = await createSession(t.ctx, { studySlug: study.slug });
    const anyId = "00000000-0000-4000-8000-000000000000";
    await expectAppError(confirmMicCheck(t.ctx, session, {}), "INVALID_STATE");
    await expectAppError(acknowledgeInstructions(t.ctx, session), "INVALID_STATE");
    await expectAppError(startTask(t.ctx, session, anyId), "INVALID_STATE");
    await expectAppError(createUtterance(t.ctx, session, { presentationId: anyId, turnIndex: 0 }), "INVALID_STATE");
    await expectAppError(skipTurn(t.ctx, session, { utteranceId: anyId }), "INVALID_STATE");
    await expectAppError(
      uploadUtteranceAudio(t.ctx, session, { utteranceId: anyId, data: sineWav() }),
      "NOT_FOUND",
    );
    await expectAppError(submitUtterance(t.ctx, session, { utteranceId: anyId, mediaAssetId: anyId }), "NOT_FOUND");
    await expectAppError(
      submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS }),
      "INVALID_STATE",
    );
    await expectAppError(
      submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS }),
      "INVALID_STATE",
    );
    await expectAppError(completeSession(t.ctx, session), "INVALID_STATE");
    expect((await sessionRow(session.id)).status).toBe("created");
    expect(await t.ctx.db.select().from(taskPresentations).where(eq(taskPresentations.sessionId, session.id))).toHaveLength(0);
    expect(await t.ctx.db.select().from(utterances).where(eq(utterances.sessionId, session.id))).toHaveLength(0);
    expect(t.storage.keys().filter((key) => key.includes(session.id))).toHaveLength(0);
  });
});

describe("microphone check and instructions", () => {
  it("stores only technical settings and cannot be skipped", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session, state } = await createSession(t.ctx, { studySlug: study.slug });
    await recordConsent(t.ctx, session, { responses: acceptAll(state) });
    await expectAppError(acknowledgeInstructions(t.ctx, session), "INVALID_STATE");

    // What an older page could still send: the raw label and the device identifiers.
    const sent = {
      deviceLabel: "Anna Virtasen AirPods Pro",
      requestedConstraints: { channelCount: 1, echoCancellation: false, deviceId: { ideal: "device-id-secret" } },
      actualTrackSettings: { channelCount: 1, sampleRate: 48000, deviceId: "device-id-secret", groupId: "group-id-secret" },
      audioContextSampleRate: 48000,
    };
    // What is stored: the device class, and no identifier of the device.
    const environment = {
      deviceLabel: "bluetooth",
      requestedConstraints: { channelCount: 1, echoCancellation: false },
      actualTrackSettings: { channelCount: 1, sampleRate: 48000 },
      audioContextSampleRate: 48000,
    };
    const next = await confirmMicCheck(t.ctx, session, { audioEnvironment: sent });
    const instructions = expectStep(next, "instructions");
    expect(instructions.instructions.content).toBe("Test instruction text.");
    const row = await sessionRow(session.id);
    expect(row.status).toBe("mic_check");
    expect(row.audioEnvironmentJson).toEqual(environment);
    expect(JSON.stringify(row)).not.toMatch(/device-id-secret|group-id-secret|Virtasen/);
    // Nothing was written to storage and no media row exists.
    expect(t.storage.keys().filter((key) => key.includes(session.id))).toHaveLength(0);
    expect(await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, session.id))).toHaveLength(0);
    // Repeating the confirmation changes nothing.
    expect((await confirmMicCheck(t.ctx, session, {})).step).toBe("instructions");
    expect((await sessionRow(session.id)).audioEnvironmentJson).toEqual(environment);
  });
});

describe("task sequence", () => {
  it("is created once, from the enabled tasks, with snapshots and randomization metadata", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session, state } = await sessionAtTasks(t.ctx, study.slug);
    const rows = await t.ctx.db
      .select()
      .from(taskPresentations)
      .where(eq(taskPresentations.sessionId, session.id))
      .orderBy(asc(taskPresentations.sequenceIndex));
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.sequenceIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    const taskById = new Map(study.tasks.map((task) => [task.id, task]));
    const keys = rows.map((row) => taskById.get(row.protocolTaskId)!.taskKey);
    expect(keys.slice(0, 3).sort()).toEqual(["controlled_a", "controlled_b", "controlled_c"]);
    expect(keys.slice(3)).toEqual(["semi_a", "semi_b", "free_speech"]);
    expect(keys).not.toContain("disabled_task");

    const stored = await sessionRow(session.id);
    for (const row of rows) {
      const task = taskById.get(row.protocolTaskId)!;
      expect(row.titleSnapshot).toBe(task.title);
      expect(row.promptSnapshot).toBe(task.participantPrompt);
      expect(row.contextSnapshot).toBe(task.contextText);
      expect(row.instructionsSnapshot).toBe(task.instructionsText);
      expect(row.status).toBe("pending");
      expect(row.randomizationMetadataJson?.seed).toBe(stored.orderSeed);
      expect(row.randomizationMetadataJson?.protocolOrderIndex).toBe(task.orderIndex);
    }
    expect(rows[0]!.randomizationMetadataJson).toMatchObject({
      algorithm: SHUFFLE_ALGORITHM,
      blockKey: "controlled",
      orderMode: "shuffle_within_block",
      indexInBlock: 0,
    });
    expect(rows[5]!.randomizationMetadataJson).toMatchObject({ blockKey: "free", orderMode: "fixed" });

    expect(state.progress).toEqual({ taskNumber: 1, totalTasks: 6 });
    expect(state.task.presentationId).toBe(rows[0]!.id);
    // Acknowledging again does not create a second sequence.
    expect((await acknowledgeInstructions(t.ctx, session)).step).toBe("tasks");
    expect(await t.ctx.db.select().from(taskPresentations).where(eq(taskPresentations.sessionId, session.id))).toHaveLength(6);
  });

  it("only lets the next task start", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session, state } = await sessionAtTasks(t.ctx, study.slug);
    const rows = await t.ctx.db
      .select()
      .from(taskPresentations)
      .where(eq(taskPresentations.sessionId, session.id))
      .orderBy(asc(taskPresentations.sequenceIndex));
    await expectAppError(startTask(t.ctx, session, rows[1]!.id), "INVALID_STATE");
    await expectAppError(
      createUtterance(t.ctx, session, { presentationId: rows[0]!.id, turnIndex: 0 }),
      "INVALID_STATE",
    );
    t.clock.advance(1000);
    const started = expectStep(await startTask(t.ctx, session, state.task.presentationId), "tasks");
    expect(started.task.status).toBe("started");
    const [row] = await t.ctx.db.select().from(taskPresentations).where(eq(taskPresentations.id, rows[0]!.id));
    expect(row!.startedAt?.getTime()).toBe(t.clock.now().getTime());
    // Starting again keeps the first start time.
    t.clock.advance(1000);
    await startTask(t.ctx, session, state.task.presentationId);
    const [again] = await t.ctx.db.select().from(taskPresentations).where(eq(taskPresentations.id, rows[0]!.id));
    expect(again!.startedAt?.getTime()).toBe(row!.startedAt?.getTime());
    await expectAppError(
      createUtterance(t.ctx, session, { presentationId: rows[0]!.id, turnIndex: 1 }),
      "INVALID_STATE",
    );
  });

  it("does not change when a new protocol is published during the session", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session, state } = await sessionAtTasks(t.ctx, study.slug);
    const before = await t.ctx.db
      .select()
      .from(taskPresentations)
      .where(eq(taskPresentations.sessionId, session.id))
      .orderBy(asc(taskPresentations.sequenceIndex));

    const newer = await insertPublishedProtocol(t.ctx.db, {
      studyId: study.study.id,
      consentVersionId: study.consent.id,
      debriefContent: "Debrief of the NEWER protocol.",
      tasks: [{ taskKey: "new_only", title: "NEWER task", participantPrompt: "Prompt of the NEWER protocol." }],
    });
    const [studyRow] = await t.ctx.db.select().from(studies).where(eq(studies.id, study.study.id));
    expect(studyRow!.currentProtocolVersionId).toBe(newer.protocol.id);

    expect(await getParticipantState(t.ctx, session)).toEqual(state);
    const end = await answerAllTasks(t.ctx, session);
    expect(end.step).toBe("background");
    const after = await t.ctx.db
      .select()
      .from(taskPresentations)
      .where(eq(taskPresentations.sessionId, session.id))
      .orderBy(asc(taskPresentations.sequenceIndex));
    expect(after.map((row) => [row.protocolTaskId, row.promptSnapshot])).toEqual(
      before.map((row) => [row.protocolTaskId, row.promptSnapshot]),
    );
    expect((await sessionRow(session.id)).protocolVersionId).toBe(study.protocol.id);
    await submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS });
    const debrief = expectStep(
      await submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS }),
      "debrief",
    );
    expect(debrief.debrief.content).toBe("Test debrief text.");
    expect(JSON.stringify(debrief)).not.toContain("NEWER");

    // A new session gets the newer protocol.
    const fresh = await sessionAtTasks(t.ctx, study.slug);
    expect((await sessionRow(fresh.session.id)).protocolVersionId).toBe(newer.protocol.id);
    expect(fresh.state.task.prompt).toBe("Prompt of the NEWER protocol.");
    expect(fresh.state.progress).toEqual({ taskNumber: 1, totalTasks: 1 });
  });
});

describe("full session", () => {
  it("runs from creation to completion with controlled, semi-structured (follow-ups) and free speech tasks", async () => {
    const study = await createTestStudy(t.ctx.db, { settings: { maxUtteranceSeconds: 200, maxUploadMb: 20 } });
    const created = await createSession(t.ctx, { studySlug: study.slug });
    const session = created.session;
    expect(created.state.step).toBe("consent");
    expect(created.state.settings).toEqual({ maxUtteranceSeconds: 200, maxUploadMb: 20, studyLaptopMode: false });
    expect(created.state.participantCode).toBe(session.participantCode);

    expect((await recordConsent(t.ctx, session, { responses: acceptAll(created.state) })).step).toBe("mic_check");
    expect((await confirmMicCheck(t.ctx, session, {})).step).toBe("instructions");
    let state = await acknowledgeInstructions(t.ctx, session);

    const seen: Array<{ type: string; title: string; turn: number; prompt: string; optional: boolean }> = [];
    let skipped = 0;
    for (let guard = 0; state.step === "tasks" && guard < 50; guard += 1) {
      const task = state.task;
      seen.push({
        type: task.taskType,
        title: task.title,
        turn: task.turn.turnIndex,
        prompt: task.turn.promptText,
        optional: task.turn.isOptional,
      });
      if (task.title === "Free speech") {
        expect(task).toMatchObject({
          privacyReminder: true,
          topicSuggestions: ["Your weekend", "A place you like"],
          instructions: "Aim for about one to two minutes.",
          suggestedDurationSeconds: 90,
          // The task allows 300 seconds, the study limit is 200.
          maxDurationSeconds: 200,
        });
      }
      if (task.turn.isOptional) {
        // The optional follow-up is skipped.
        const started = task.status === "pending" ? await startTask(t.ctx, session, task.presentationId) : state;
        expect(started.step).toBe("tasks");
        const { utteranceId } = await createUtterance(t.ctx, session, {
          presentationId: task.presentationId,
          turnIndex: task.turn.turnIndex,
        });
        state = await skipTurn(t.ctx, session, { utteranceId });
        skipped += 1;
      } else {
        state = (await answerCurrentTurn(t.ctx, session)).state;
      }
    }
    expect(skipped).toBe(1);
    expect(seen.filter((entry) => entry.type === "controlled")).toHaveLength(3);
    expect(seen.slice(3)).toEqual([
      { type: "semi_structured", title: "Semi-structured A", turn: 0, prompt: "Prompt of semi-structured task A.", optional: false },
      { type: "semi_structured", title: "Semi-structured A", turn: 1, prompt: "Required follow-up prompt.", optional: false },
      { type: "semi_structured", title: "Semi-structured A", turn: 2, prompt: "Optional follow-up prompt.", optional: true },
      { type: "semi_structured", title: "Semi-structured B", turn: 0, prompt: "Prompt of semi-structured task B.", optional: false },
      { type: "free_speech", title: "Free speech", turn: 0, prompt: "Prompt of the free speech task.", optional: false },
    ]);

    // Seven accepted recordings: 3 controlled, 2 for semi A, 1 for semi B, 1 free.
    const rows = await t.ctx.db.select().from(utterances).where(eq(utterances.sessionId, session.id));
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.status === "submitted" && row.acceptedMediaAssetId && row.submittedAt)).toBe(true);
    const followupRow = rows.find((row) => row.turnIndex === 1)!;
    expect(followupRow.promptSnapshot).toBe("Required follow-up prompt.");
    expect(followupRow.followupId).toBe(study.followups.find((f) => f.followupKey === "required_followup")!.id);
    expect(rows.filter((row) => row.turnIndex === 0).every((row) => row.followupId === null)).toBe(true);
    const media = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, session.id));
    expect(media).toHaveLength(7);
    expect(t.storage.keys().filter((key) => key.includes(session.id))).toHaveLength(7);
    const presentations = await t.ctx.db.select().from(taskPresentations).where(eq(taskPresentations.sessionId, session.id));
    expect(presentations.every((row) => row.status === "completed" && row.startedAt && row.completedAt)).toBe(true);

    // Background questionnaire, only now.
    const background = expectStep(state, "background");
    expect(background.progress).toBeNull();
    expect(background.questionnaire.key).toBe("background");
    expect(background.questionnaire.questionnaireVersionId).toBe(study.background!.version.id);
    expect(background.questionnaire.items.map((item) => item.itemKey)).toEqual(["age_range", "region", "languages", "years", "moved"]);
    expect((await sessionRow(session.id)).status).toBe("background_questionnaire");
    state = await submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS });

    const post = expectStep(state, "post_recording");
    expect(post.questionnaire.items[0]).toMatchObject({ itemKey: "naturalness", type: "likert", config: { scaleMin: 1, scaleMax: 5 } });
    await expectAppError(completeSession(t.ctx, session), "INVALID_STATE");
    state = await submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS });

    const debrief = expectStep(state, "debrief");
    expect(debrief.debrief).toEqual({ content: "Test debrief text.", contactText: null });
    expect(debrief.participantCode).toBe(session.participantCode);
    expect((await sessionRow(session.id)).status).toBe("post_questionnaire");

    t.clock.advance(1000);
    state = await completeSession(t.ctx, session);
    expect(state.step).toBe("completed");
    const final = await sessionRow(session.id);
    expect(final.status).toBe("completed");
    expect(final.completedAt?.getTime()).toBe(t.clock.now().getTime());
    // Completing twice is harmless, and nothing can be written afterwards.
    expect((await completeSession(t.ctx, session)).step).toBe("completed");
    await expectAppError(withdrawSession(t.ctx, session), "INVALID_STATE");
    await expectAppError(
      submitQuestionnaire(t.ctx, session, { key: "background", answers: { age_range: "18_24", region: "X" } }),
      "INVALID_STATE",
    );
    const responses = await t.ctx.db.select().from(questionnaireResponses).where(eq(questionnaireResponses.sessionId, session.id));
    expect(responses).toHaveLength(2);
  });

  it("goes from the tasks straight to the debrief when the protocol has no questionnaires", async () => {
    const study = await createTestStudy(t.ctx.db, {
      withBackground: false,
      withPost: false,
      tasks: [{ taskKey: "only", title: "Only task", participantPrompt: "Only prompt." }],
    });
    const { session } = await sessionAtTasks(t.ctx, study.slug);
    const end = await answerAllTasks(t.ctx, session);
    expect(end.step).toBe("debrief");
    await expectAppError(submitQuestionnaire(t.ctx, session, { key: "background", answers: {} }), "NOT_FOUND");
    expect((await completeSession(t.ctx, session)).step).toBe("completed");
  });

  it("skips only the missing questionnaire", async () => {
    const study = await createTestStudy(t.ctx.db, {
      withBackground: false,
      tasks: [{ taskKey: "only", title: "Only task", participantPrompt: "Only prompt." }],
    });
    const { session } = await sessionAtTasks(t.ctx, study.slug);
    expect((await answerAllTasks(t.ctx, session)).step).toBe("post_recording");
    expect(
      (await submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS })).step,
    ).toBe("debrief");
  });

  it("gives the same state when asked again at every step (refresh resilience)", async () => {
    const study = await createTestStudy(t.ctx.db, {
      tasks: [
        {
          taskKey: "semi",
          taskType: "semi_structured",
          title: "Semi",
          participantPrompt: "Main prompt.",
          followups: [{ followupKey: "f1", promptText: "Follow-up prompt." }],
        },
      ],
    });
    const created = await createSession(t.ctx, { studySlug: study.slug });
    const session = created.session;
    const same = async (expected: unknown) => {
      // A reload resolves the session from the cookie token again.
      const resolved = await getSessionByToken(t.ctx, created.token);
      expect(await getParticipantState(t.ctx, resolved)).toEqual(expected);
      expect(await getParticipantState(t.ctx, resolved)).toEqual(expected);
    };
    await same(created.state);
    await same(await recordConsent(t.ctx, session, { responses: acceptAll(created.state) }));
    await same(await confirmMicCheck(t.ctx, session, {}));
    const tasks = expectStep(await acknowledgeInstructions(t.ctx, session), "tasks");
    await same(tasks);
    await same(await startTask(t.ctx, session, tasks.task.presentationId));
    const { utteranceId, state: withUtterance } = await createUtterance(t.ctx, session, {
      presentationId: tasks.task.presentationId,
      turnIndex: 0,
    });
    expect(expectStep(withUtterance, "tasks").task.turn.utteranceId).toBe(utteranceId);
    await same(withUtterance);
    // Creating the utterance again returns the same row.
    expect(
      (await createUtterance(t.ctx, session, { presentationId: tasks.task.presentationId, turnIndex: 0 })).utteranceId,
    ).toBe(utteranceId);

    const upload = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(400) });
    const withCandidate = expectStep(await getParticipantState(t.ctx, session), "tasks");
    expect(withCandidate.task.turn.candidate).toEqual({ mediaAssetId: upload.mediaAssetId, durationMs: 400 });
    await same(withCandidate);
    const afterDiscard = expectStep(await discardCandidate(t.ctx, session, { utteranceId }), "tasks");
    expect(afterDiscard.task.turn).toMatchObject({ utteranceId, candidate: null });

    const second = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(400) });
    const followup = expectStep(
      await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: second.mediaAssetId }),
      "tasks",
    );
    expect(followup.task.turn).toMatchObject({
      turnIndex: 1,
      totalTurns: 2,
      promptText: "Follow-up prompt.",
      isFollowup: true,
      isOptional: false,
      utteranceId: null,
      candidate: null,
    });
    await same(followup);
    await same((await answerCurrentTurn(t.ctx, session)).state);
    await same(await submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS }));
    await same(await submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS }));
    await same(await completeSession(t.ctx, session));
  });

  it("lets the participant skip every follow-up when the task makes follow-ups optional", async () => {
    const study = await createTestStudy(t.ctx.db, {
      withBackground: false,
      withPost: false,
      tasks: [
        {
          taskKey: "semi",
          taskType: "semi_structured",
          title: "Semi",
          participantPrompt: "Main prompt.",
          configJson: { followupMode: "optional" },
          followups: [
            { followupKey: "f1", promptText: "First follow-up." },
            { followupKey: "f2", promptText: "Second follow-up." },
          ],
        },
        { taskKey: "last", title: "Last", participantPrompt: "Last prompt." },
      ],
    });
    const { session } = await sessionAtTasks(t.ctx, study.slug);
    // The main prompt cannot be skipped.
    let state = expectStep(await getParticipantState(t.ctx, session), "tasks");
    state = expectStep(await startTask(t.ctx, session, state.task.presentationId), "tasks");
    const main = await createUtterance(t.ctx, session, { presentationId: state.task.presentationId, turnIndex: 0 });
    await expectAppError(skipTurn(t.ctx, session, { utteranceId: main.utteranceId }), "INVALID_STATE");
    state = expectStep((await answerCurrentTurn(t.ctx, session)).state, "tasks");
    expect(state.task.turn).toMatchObject({ turnIndex: 1, isOptional: true });

    // Skip the first follow-up after uploading a candidate for it: the candidate goes too.
    const first = await createUtterance(t.ctx, session, { presentationId: state.task.presentationId, turnIndex: 1 });
    await uploadUtteranceAudio(t.ctx, session, { utteranceId: first.utteranceId, data: sineWav() });
    const objectsBefore = t.storage.keys().filter((key) => key.includes(session.id)).length;
    state = expectStep(await skipTurn(t.ctx, session, { utteranceId: first.utteranceId }), "tasks");
    expect(t.storage.keys().filter((key) => key.includes(session.id))).toHaveLength(objectsBefore - 1);
    expect(state.task.turn).toMatchObject({ turnIndex: 2, promptText: "Second follow-up.", isOptional: true });
    expect(state.task.turn.utteranceId).not.toBeNull();
    // The state is stable after the skip.
    expect(await getParticipantState(t.ctx, session)).toEqual(state);

    // Answer the second follow-up: the task completes and the next one is current.
    state = expectStep((await answerCurrentTurn(t.ctx, session)).state, "tasks");
    expect(state.task.title).toBe("Last");
    const rows = await t.ctx.db
      .select()
      .from(utterances)
      .where(eq(utterances.sessionId, session.id))
      .orderBy(asc(utterances.turnIndex));
    // The skipped turn 1 left no row.
    expect(rows.map((row) => [row.turnIndex, row.status])).toEqual([
      [0, "submitted"],
      [2, "submitted"],
    ]);
  });
});

describe("questionnaires", () => {
  async function sessionAtBackground() {
    const study = await createTestStudy(t.ctx.db, {
      tasks: [{ taskKey: "only", title: "Only task", participantPrompt: "Only prompt." }],
    });
    const { session } = await sessionAtTasks(t.ctx, study.slug);
    return { study, session };
  }

  it("cannot be answered before the speech tasks are done, and the post questionnaire not before the background one", async () => {
    const { session } = await sessionAtBackground();
    await expectAppError(
      submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS }),
      "INVALID_STATE",
    );
    await answerAllTasks(t.ctx, session);
    await expectAppError(
      submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS }),
      "INVALID_STATE",
    );
    expect(await t.ctx.db.select().from(questionnaireResponses).where(eq(questionnaireResponses.sessionId, session.id))).toHaveLength(0);
  });

  it("validates required items, types, ranges, options and lengths, and stores nothing when invalid", async () => {
    const { session } = await sessionAtBackground();
    await answerAllTasks(t.ctx, session);
    const issuesFor = async (answers: Record<string, unknown>) => {
      const error = await expectAppError(submitQuestionnaire(t.ctx, session, { key: "background", answers }), "VALIDATION_ERROR");
      return (error.details as { issues: Array<{ path: string; message: string }> }).issues.map((issue) => issue.path);
    };
    expect(await issuesFor({})).toEqual(["age_range", "region"]);
    expect(await issuesFor({ age_range: "", region: "   " })).toEqual(["age_range", "region"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, age_range: "not_an_option" })).toEqual(["age_range"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, region: "x".repeat(51) })).toEqual(["region"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, region: 12 })).toEqual(["region"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, languages: ["fi", "xx"] })).toEqual(["languages"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, languages: "fi" })).toEqual(["languages"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, years: 121 })).toEqual(["years"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, years: -1 })).toEqual(["years"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, years: 1.5 })).toEqual(["years"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, moved: "yes" })).toEqual(["moved"]);
    expect(await issuesFor({ ...VALID_BACKGROUND_ANSWERS, unknown_item: 1 })).toEqual(["unknown_item"]);
    expect(await t.ctx.db.select().from(questionnaireResponses).where(eq(questionnaireResponses.sessionId, session.id))).toHaveLength(0);
    expect((await getParticipantState(t.ctx, session)).step).toBe("background");

    await submitQuestionnaire(t.ctx, session, { key: "background", answers: { age_range: "18_24", region: "Oulu", languages: [] } });
    const likertIssues = async (value: unknown) => {
      const error = await expectAppError(
        submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: { naturalness: value } }),
        "VALIDATION_ERROR",
      );
      return (error.details as { issues: Array<{ path: string }> }).issues.map((issue) => issue.path);
    };
    expect(await likertIssues(0)).toEqual(["naturalness"]);
    expect(await likertIssues(6)).toEqual(["naturalness"]);
    expect(await likertIssues(2.5)).toEqual(["naturalness"]);
    expect(await likertIssues("3")).toEqual(["naturalness"]);
  });

  it("stores one response with one answer per answered item, and a repeat changes nothing", async () => {
    const { study, session } = await sessionAtBackground();
    await answerAllTasks(t.ctx, session);
    t.clock.advance(1000);
    const [first, second] = await Promise.all([
      submitQuestionnaire(t.ctx, session, { key: "background", answers: { age_range: "18_24", region: "Oulu", years: 0, moved: false } }),
      submitQuestionnaire(t.ctx, session, { key: "background", answers: { age_range: "18_24", region: "Oulu", years: 0, moved: false } }),
    ]);
    expect(first.step).toBe("post_recording");
    expect(second.step).toBe("post_recording");
    // A later repeat with other answers is ignored.
    await submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS });

    const responses = await t.ctx.db.select().from(questionnaireResponses).where(eq(questionnaireResponses.sessionId, session.id));
    expect(responses).toHaveLength(1);
    expect(responses[0]!.questionnaireVersionId).toBe(study.background!.version.id);
    expect(responses[0]!.submittedAt.getTime()).toBe(t.clock.now().getTime());
    const answers = await t.ctx.db.select().from(questionnaireAnswers).where(eq(questionnaireAnswers.responseId, responses[0]!.id));
    const itemKey = new Map(study.background!.items.map((item) => [item.id, item.itemKey]));
    expect(Object.fromEntries(answers.map((answer) => [itemKey.get(answer.questionnaireItemId), answer.valueJson]))).toEqual({
      age_range: "18_24",
      region: "Oulu",
      years: 0,
      moved: false,
    });
  });
});

describe("withdrawal and abandonment", () => {
  it("withdrawal removes the recording that was not submitted, keeps submitted data and returns the debrief", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session } = await sessionAtTasks(t.ctx, study.slug);
    const submitted = await answerCurrentTurn(t.ctx, session);
    const state = expectStep(submitted.state, "tasks");
    await startTask(t.ctx, session, state.task.presentationId);
    const { utteranceId } = await createUtterance(t.ctx, session, { presentationId: state.task.presentationId, turnIndex: 0 });
    const candidate = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(500) });
    expect(t.storage.keys().filter((key) => key.includes(session.id))).toHaveLength(2);

    t.clock.advance(1000);
    const ended = expectStep(await withdrawSession(t.ctx, session), "withdrawn");
    expect(ended.debrief).toEqual({ content: "Test debrief text.", contactText: null });
    expect(ended.participantCode).toBe((await sessionRow(session.id)).participantCode);

    const row = await sessionRow(session.id);
    expect(row.status).toBe("withdrawn");
    expect(row.withdrawnAt?.getTime()).toBe(t.clock.now().getTime());
    expect(row.completedAt).toBeNull();
    const media = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, session.id));
    expect(media.map((asset) => asset.id)).toEqual([submitted.mediaAssetId]);
    expect(media.some((asset) => asset.id === candidate.mediaAssetId)).toBe(false);
    const keys = t.storage.keys().filter((key) => key.includes(session.id));
    expect(keys).toEqual([media[0]!.storageKey]);
    const kept = await t.ctx.db.select().from(utterances).where(eq(utterances.id, submitted.utteranceId));
    expect(kept[0]!.status).toBe("submitted");

    // Withdrawing twice is harmless. Nothing can be written afterwards.
    expect((await withdrawSession(t.ctx, session)).step).toBe("withdrawn");
    await expectAppError(uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav() }), "INVALID_STATE");
    await expectAppError(createUtterance(t.ctx, session, { presentationId: state.task.presentationId, turnIndex: 0 }), "INVALID_STATE");
    await expectAppError(completeSession(t.ctx, session), "INVALID_STATE");
  });

  it("marks inactive sessions abandoned after the timeout, removes their candidates and leaves active and finished sessions alone", async () => {
    // Earlier tests left sessions behind: move past the pre-consent timeout and settle them first.
    t.clock.advance(31 * 60 * 1000);
    await markAbandonedSessions(t.ctx);
    const study = await createTestStudy(t.ctx.db, { settings: { sessionInactivityTimeoutMinutes: 30 } });
    const stale = await sessionAtTasks(t.ctx, study.slug);
    const submitted = await answerCurrentTurn(t.ctx, stale.session);
    const staleState = expectStep(submitted.state, "tasks");
    await startTask(t.ctx, stale.session, staleState.task.presentationId);
    const { utteranceId } = await createUtterance(t.ctx, stale.session, {
      presentationId: staleState.task.presentationId,
      turnIndex: 0,
    });
    await uploadUtteranceAudio(t.ctx, stale.session, { utteranceId, data: sineWav() });
    const preConsent = await createSession(t.ctx, { studySlug: study.slug });
    const withdrawn = await sessionAtTasks(t.ctx, study.slug);
    await withdrawSession(t.ctx, withdrawn.session);

    t.clock.advance(20 * 60 * 1000);
    const active = await createSession(t.ctx, { studySlug: study.slug });
    expect(await markAbandonedSessions(t.ctx)).toBe(0);

    t.clock.advance(11 * 60 * 1000);
    expect(await markAbandonedSessions(t.ctx)).toBe(2);
    const staleRow = await sessionRow(stale.session.id);
    expect(staleRow.status).toBe("abandoned");
    expect(staleRow.abandonedAt?.getTime()).toBe(t.clock.now().getTime());
    expect(staleRow.completedAt).toBeNull();
    expect((await sessionRow(preConsent.session.id)).status).toBe("abandoned");
    expect((await sessionRow(withdrawn.session.id)).status).toBe("withdrawn");
    expect((await sessionRow(active.session.id)).status).toBe("created");

    const media = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, stale.session.id));
    expect(media.map((asset) => asset.id)).toEqual([submitted.mediaAssetId]);
    expect(t.storage.keys().filter((key) => key.includes(stale.session.id))).toEqual([media[0]!.storageKey]);

    // The token of an abandoned session no longer resolves.
    await expectAppError(getSessionByToken(t.ctx, stale.created.token), "SESSION_EXPIRED");
    await expectAppError(uploadUtteranceAudio(t.ctx, stale.session, { utteranceId, data: sineWav() }), "INVALID_STATE");
    // A second run finds nothing new.
    expect(await markAbandonedSessions(t.ctx)).toBe(0);
  });

  it("abandons a session that never recorded consent after the short pre-consent timeout and removes its browser data", async () => {
    t.clock.advance(31 * 60 * 1000);
    await markAbandonedSessions(t.ctx);
    // Normal timeout 120 minutes (the default), pre-consent timeout 30 minutes (the default).
    const study = await createTestStudy(t.ctx.db);
    const junk = await createSession(t.ctx, { studySlug: study.slug, browserInfo: { userAgent: "Script/1.0" } });
    const consented = await createSession(t.ctx, { studySlug: study.slug, browserInfo: { userAgent: "Person/1.0" } });
    await recordConsent(t.ctx, consented.session, { responses: acceptAll(consented.state) });
    // A demo session never passes the consent step: it keeps the normal timeout.
    const demoStudy = await createTestStudy(t.ctx.db, { settings: { demoPublic: true } });
    const demo = await createSession(t.ctx, { studySlug: demoStudy.slug, mode: "demo" });

    // Sessions of earlier tests can time out as well, so rows are checked, not counts.
    t.clock.advance(29 * 60 * 1000);
    await markAbandonedSessions(t.ctx);
    expect((await sessionRow(junk.session.id)).status).toBe("created");
    t.clock.advance(2 * 60 * 1000);
    await markAbandonedSessions(t.ctx);

    const junkRow = await sessionRow(junk.session.id);
    expect(junkRow.status).toBe("abandoned");
    expect(junkRow.browserInfoJson).toBeNull();
    expect(junkRow.tokenHash).toBeNull();
    expect((await sessionRow(consented.session.id)).status).toBe("consented");
    expect((await sessionRow(consented.session.id)).browserInfoJson).toMatchObject({ userAgent: "Person/1.0" });
    expect((await sessionRow(demo.session.id)).status).toBe("created");

    // The timeout is a study setting.
    const quick = await createTestStudy(t.ctx.db, {
      // The key is not in the StudySettings type of the database package yet.
      settings: { preConsentTimeoutMinutes: 5 } as StudySettings,
    });
    const short = await createSession(t.ctx, { studySlug: quick.slug });
    t.clock.advance(4 * 60 * 1000);
    await markAbandonedSessions(t.ctx);
    expect((await sessionRow(short.session.id)).status).toBe("created");
    t.clock.advance(2 * 60 * 1000);
    await markAbandonedSessions(t.ctx);
    expect((await sessionRow(short.session.id)).status).toBe("abandoned");
  });

  it("maintenance mode stops a running session until it is switched off", async () => {
    const study = await createTestStudy(t.ctx.db);
    const { session, state } = await sessionAtTasks(t.ctx, study.slug);
    await updateSettings(t.ctx.db, study.study.id, { maintenanceMode: true, maintenanceMessage: "Back soon." });
    const error = await expectAppError(startTask(t.ctx, session, state.task.presentationId), "STUDY_CLOSED");
    expect(error.message).toBe("Back soon.");
    await updateSettings(t.ctx.db, study.study.id, { maintenanceMode: false });
    expect((await startTask(t.ctx, session, state.task.presentationId)).step).toBe("tasks");
    // Pausing new sessions does not stop a running one (spec 87).
    await updateSettings(t.ctx.db, study.study.id, { allowNewSessions: false });
    expect((await answerCurrentTurn(t.ctx, session)).state.step).toBe("tasks");
  });
});

describe("no AI output reaches the participant", () => {
  const SECRETS = {
    asrText: "ZZ_SECRET_ASR_OUTPUT_ZZ",
    humanText: "ZZ_SECRET_HUMAN_TRANSCRIPT_ZZ",
    translation: "ZZ_SECRET_TRANSLATION_ZZ",
    asrModel: "zz-secret-asr-model",
    translationModel: "zz-secret-translation-model",
    ttsModel: "zz-secret-tts-model",
    provider: "zz-secret-provider",
    condition: "zz_secret_condition",
  };
  const FORBIDDEN_KEY = /transcri|translat|asr|tts|synthes|model|provider|condition|dialect|classif|prompt(?!Text)/i;
  const ALLOWED_KEYS = new Set(["prompt"]);

  function collectKeys(value: unknown, keys: Set<string>): void {
    if (Array.isArray(value)) value.forEach((entry) => collectKeys(entry, keys));
    else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        keys.add(key);
        collectKeys(entry, keys);
      }
    }
  }

  function assertClean(state: unknown): void {
    const serialized = JSON.stringify(state);
    for (const secret of Object.values(SECRETS)) expect(serialized).not.toContain(secret);
    const keys = new Set<string>();
    collectKeys(state, keys);
    const forbidden = [...keys].filter((key) => !ALLOWED_KEYS.has(key) && FORBIDDEN_KEY.test(key));
    expect(forbidden).toEqual([]);
  }

  it("at every step of a whole session, also when ASR output and translations exist in the database", async () => {
    const study = await createTestStudy(t.ctx.db, { settings: { autoQueueAsr: true }, aiConfigs: false });
    await insertActiveAiConfigs(t.ctx.db, {
      studyId: study.study.id,
      provider: SECRETS.provider,
      models: { asr: SECRETS.asrModel, translation: SECRETS.translationModel, tts: SECRETS.ttsModel },
    });
    const batch = await insertProcessingBatch(t.ctx.db, { studyId: study.study.id });

    // What the pipeline writes for an utterance while the session is still running.
    const addAiOutput = async (utteranceId: string) => {
      await insertTranscriptWithRevision(t.ctx.db, { utteranceId, type: "asr", text: SECRETS.asrText });
      const human = await insertTranscriptWithRevision(t.ctx.db, { utteranceId, type: "human_dialect", text: SECRETS.humanText });
      await insertTranslation(t.ctx.db, {
        sourceTranscriptRevisionId: human.revision.id,
        processingBatchId: batch.id,
        conditionKey: SECRETS.condition,
        translatedText: SECRETS.translation,
        modelRun: { provider: SECRETS.provider, requestedModel: SECRETS.translationModel },
      });
    };

    const states: unknown[] = [];
    const created = await createSession(t.ctx, { studySlug: study.slug });
    const session = created.session;
    states.push(created.state);
    states.push(await getPublicStudyInfo(t.ctx, { studySlug: study.slug }));
    states.push(await recordConsent(t.ctx, session, { responses: acceptAll(created.state) }));
    states.push(await confirmMicCheck(t.ctx, session, {}));
    let state = await acknowledgeInstructions(t.ctx, session);
    states.push(state);
    for (let guard = 0; state.step === "tasks" && guard < 50; guard += 1) {
      states.push(await startTask(t.ctx, session, state.task.presentationId));
      const slot = await createUtterance(t.ctx, session, {
        presentationId: state.task.presentationId,
        turnIndex: state.task.turn.turnIndex,
      });
      states.push(slot);
      const upload = await uploadUtteranceAudio(t.ctx, session, { utteranceId: slot.utteranceId, data: sineWav() });
      states.push(upload);
      states.push(await getParticipantState(t.ctx, session));
      state = await submitUtterance(t.ctx, session, { utteranceId: slot.utteranceId, mediaAssetId: upload.mediaAssetId });
      states.push(state);
      await addAiOutput(slot.utteranceId);
      states.push(await getParticipantState(t.ctx, session));
    }
    states.push(await submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS }));
    states.push(await submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS }));
    states.push(await completeSession(t.ctx, session));
    states.push(await getParticipantState(t.ctx, session));

    const withdrawn = await sessionAtTasks(t.ctx, study.slug);
    const answered = await answerCurrentTurn(t.ctx, withdrawn.session);
    await addAiOutput(answered.utteranceId);
    states.push(await withdrawSession(t.ctx, withdrawn.session));

    expect(states.length).toBeGreaterThan(50);
    for (const entry of states) assertClean(entry);
    // The check itself works: it finds a planted value and a planted key.
    expect(() => assertClean({ note: SECRETS.asrText })).toThrow();
    expect(() => assertClean({ task: { asrText: "x" } })).toThrow();
    expect(() => assertClean({ modelName: "x" })).toThrow();
    // The participant-facing task rows were never touched by the pipeline data.
    const taskRows = await t.ctx.db.select().from(protocolTasks).where(eq(protocolTasks.protocolVersionId, study.protocol.id));
    expect(taskRows.length).toBeGreaterThan(0);
  });
});
