import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  adminAuditLog,
  jobs,
  mediaAssets,
  modelConfigs,
  modelRuns,
  processingBatches,
  rateLimitHits,
  sessions,
  studies,
  syntheses,
  taskPresentations,
  transcriptRevisions,
  translations,
  utterances,
} from "@dialect/db";
import { insertActiveAiConfigs, insertPublishedProtocol, insertStudy } from "@dialect/db/testing-builders";
import { AppError, demoSchemas } from "@dialect/domain";
import { generateSineWav } from "@dialect/storage";
import { getUtteranceLineage } from "../processing/lineage";
import {
  addUtterance,
  insertConfig,
  RESEARCH_TEST_PROVIDER,
  retireConfig,
  setupEnv,
  type TestEnv,
} from "../processing/test-helpers";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  completeDemoSession,
  createDemoUtterance,
  demoAcknowledgementOf,
  demoBudgetBucket,
  demoSettings,
  MAX_STEP_ATTEMPTS,
  findDemoSessionByToken,
  getDemoAccess,
  getDemoMediaForStreaming,
  getLastPipelineTest,
  listLeftoverDemoSessions,
  MOCK_CONFIG_KEYS,
  purgeDemoSession,
  purgeLeftoverDemoSessions,
  runDemoPipeline,
  runPipelineTest,
  startDemoSession,
} from "./index";

let t: TestServiceContext;
let toneCounter = 0;

function tone(durationMs = 400): Buffer {
  toneCounter += 1;
  return generateSineWav({ durationMs, sampleRateHz: 16000, frequencyHz: 300 + toneCounter * 7 });
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected an AppError with the code ${code}`);
}

async function setSettings(env: TestEnv, settings: Record<string, unknown>): Promise<void> {
  await t.testDb.db
    .update(studies)
    .set({ settingsJson: { sourceLanguage: "fi", targetLanguage: "en", ...settings } })
    .where(eq(studies.id, env.study.id));
}

async function startDemo(env: TestEnv) {
  return startDemoSession(t.adminCtx, { acknowledged: true, isAdmin: true, studySlug: env.study.slug });
}

async function recordAndRun(env: TestEnv, sessionId: string, options: Parameters<typeof runDemoPipeline>[1] | object = {}) {
  const stored = await createDemoUtterance(t.ctx, { id: sessionId }, { data: tone(), declaredMimeType: "audio/wav" });
  const result = await runDemoPipeline(t.ctx, { sessionId, utteranceId: stored.utteranceId, ...options });
  return { stored, result };
}

beforeAll(async () => {
  t = await createTestServiceContext();
});

afterAll(async () => {
  await t.cleanup();
});

describe("demo session creation", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupEnv(t);
  });

  it("lets an admin start a demo session and stores the accepted recording notice", async () => {
    const started = await startDemoSession(t.adminCtx, {
      acknowledged: true,
      isAdmin: true,
      studySlug: env.study.slug,
      browserInfo: { userAgent: "test-agent" },
    });
    expect(started.session.mode).toBe("demo");
    expect(started.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const acknowledgement = demoAcknowledgementOf(started.session);
    expect(acknowledgement?.acknowledgedAt).toBe(t.clock.now().toISOString());
    expect(acknowledgement?.noticeVersion).toBe(demoSchemas.DEMO_RECORDING_NOTICE.version);
    expect(acknowledgement?.noticeText.join(" ")).toContain("external AI service");
    expect(started.session.browserInfoJson?.userAgent).toBe("test-agent");
    // The cookie token finds this session, and only while it is an open demo session.
    expect((await findDemoSessionByToken(t.ctx, started.token))?.id).toBe(started.session.id);
    expect(await findDemoSessionByToken(t.ctx, "x".repeat(43))).toBeNull();
  });

  it("refuses a visitor while the study setting demoPublic is false", async () => {
    await setSettings(env, { demoPublic: false });
    await expectAppError(
      startDemoSession(t.ctx, { acknowledged: true, isAdmin: false, studySlug: env.study.slug }),
      "FORBIDDEN",
    );
    const access = await getDemoAccess(t.ctx, { isAdmin: false, studySlug: env.study.slug });
    expect(access).toMatchObject({ demoPublic: false, demoPersist: true, mockAvailable: false });
  });

  it("takes the recording limits of Demo Mode from the study settings", async () => {
    await setSettings(env, { maxUtteranceSeconds: 240, maxUploadMb: 40 });
    expect(await getDemoAccess(t.ctx, { isAdmin: false, studySlug: env.study.slug })).toMatchObject({
      maxRecordingSeconds: 240,
      maxUploadBytes: 40 * 1024 * 1024,
    });
    await setSettings(env, {});
  });

  it("lets anyone start a demo session when demoPublic is true, without the mock option", async () => {
    await setSettings(env, { demoPublic: true, allowNewSessions: true });
    const started = await startDemoSession(t.ctx, { acknowledged: true, isAdmin: false, studySlug: env.study.slug });
    expect(started.session.mode).toBe("demo");
    expect((await getDemoAccess(t.ctx, { isAdmin: false, studySlug: env.study.slug })).mockAvailable).toBe(false);
    expect((await getDemoAccess(t.adminCtx, { isAdmin: true, studySlug: env.study.slug })).mockAvailable).toBe(true);
    await setSettings(env, {});
  });

  it("creates nothing without the acknowledgement", async () => {
    const before = await t.testDb.db.select().from(sessions).where(eq(sessions.studyId, env.study.id));
    await expectAppError(
      startDemoSession(t.adminCtx, { acknowledged: false, isAdmin: true, studySlug: env.study.slug }),
      "VALIDATION_ERROR",
    );
    const after = await t.testDb.db.select().from(sessions).where(eq(sessions.studyId, env.study.id));
    expect(after).toHaveLength(before.length);
  });

  it("never accepts a research session on the demo recording path", async () => {
    const research = await addUtterance(env, { mode: "research" });
    await expectAppError(createDemoUtterance(t.ctx, { id: research.session.id }, { data: tone() }), "FORBIDDEN");
    await expectAppError(
      runDemoPipeline(t.ctx, { sessionId: research.session.id, utteranceId: research.utterance.id }),
      "FORBIDDEN",
    );
  });
});

describe("demo recording and pipeline", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupEnv(t);
  });

  it("stores the recording as an immutable submitted utterance on a carrier task", async () => {
    const { session } = await startDemo(env);
    const audio = tone();
    const stored = await createDemoUtterance(t.ctx, session, { data: audio, declaredMimeType: "audio/wav" });
    expect(stored.turnIndex).toBe(0);
    expect(stored.source.captureQualityClass).toBe("lossless_pcm");
    expect(await t.storage.exists(stored.storageKey)).toBe(true);

    const [utterance] = await t.testDb.db.select().from(utterances).where(eq(utterances.id, stored.utteranceId));
    expect(utterance).toMatchObject({ status: "submitted", acceptedMediaAssetId: stored.mediaAssetId, turnIndex: 0 });
    const [media] = await t.testDb.db.select().from(mediaAssets).where(eq(mediaAssets.id, stored.mediaAssetId));
    expect(media).toMatchObject({ kind: "source_audio", sessionId: session.id, sizeBytes: audio.length });
    expect(media!.sha256).toBe(stored.source.sha256);
    const presentations = await t.testDb.db
      .select()
      .from(taskPresentations)
      .where(eq(taskPresentations.sessionId, session.id));
    expect(presentations).toHaveLength(1);
    expect(presentations[0]!.titleSnapshot).toBe("Demo recording");
    expect(presentations[0]!.promptSnapshot).toContain("not a study task");
    expect(env.tasks.map((task) => task.id)).toContain(presentations[0]!.protocolTaskId);

    // The accepted recording of a submitted utterance cannot be replaced.
    await expect(
      t.testDb.db.update(utterances).set({ acceptedMediaAssetId: null, status: "recording" }).where(eq(utterances.id, stored.utteranceId)),
    ).rejects.toThrow();

    // A second recording of the same session is the next turn of the same presentation.
    const second = await createDemoUtterance(t.ctx, session, { data: tone() });
    expect(second.turnIndex).toBe(1);
    expect(second.taskPresentationId).toBe(stored.taskPresentationId);
  });

  it("rejects audio that is not a recording", async () => {
    const { session } = await startDemo(env);
    await expectAppError(createDemoUtterance(t.ctx, session, { data: Buffer.from("not audio at all") }), "INVALID_AUDIO");
    expect(await t.testDb.db.select().from(utterances).where(eq(utterances.sessionId, session.id))).toHaveLength(0);
  });

  it("produces ASR, two translations and two syntheses with full provenance in a demo batch", async () => {
    const { session } = await startDemo(env);
    const { stored, result } = await recordAndRun(env, session.id);

    expect(result.ok).toBe(true);
    expect(result.dataMode).toBe("demo");
    expect(result.providerMode).toBe("active");
    expect(result.isMock).toBe(true);
    expect(result.asr.status).toBe("succeeded");
    expect(result.asr.text).toContain("[mock-transkriptio");
    expect(result.asr.provenance).toMatchObject({ configKey: "asr_default", provider: "mock" });
    expect(result.asr.provenance?.modelRunId).toBeTruthy();
    expect(result.conditions.map((condition) => [condition.conditionKey, condition.label])).toEqual([
      ["default", "Default translation"],
      ["preservation", "Preserve variation"],
    ]);
    for (const condition of result.conditions) {
      expect(condition.translation.status).toBe("succeeded");
      expect(condition.translation.text).toContain("[mock translation");
      expect(condition.translation.provenance?.promptKey).toBeTruthy();
      expect(condition.synthesis.status).toBe("succeeded");
      expect(condition.synthesis.mediaAssetId).toBeTruthy();
      expect(condition.synthesis.provenance).toMatchObject({ configKey: "tts_baseline" });
    }
    // Different instructions give different outputs for the two conditions.
    expect(result.conditions[0]!.translation.text).not.toBe(result.conditions[1]!.translation.text);

    const [batch] = await t.testDb.db
      .select()
      .from(processingBatches)
      .where(eq(processingBatches.id, result.processingBatchId!));
    expect(batch).toMatchObject({ dataMode: "demo", status: "completed", name: `demo-${session.participantCode}` });
    expect(batch!.configurationSnapshotJson.selection).toMatchObject({ mode: ["demo"], sessionIds: [session.id] });
    expect(batch!.configurationSnapshotJson.translations).toHaveLength(2);
    expect(batch!.configurationSnapshotJson.asr?.modelConfigId).toBe(env.ai.configs.asrDefault.id);

    const runs = await t.testDb.db.select().from(modelRuns).where(eq(modelRuns.processingBatchId, batch!.id));
    expect(runs).toHaveLength(5);
    expect(runs.every((run) => run.status === "succeeded" && run.modelConfigId !== null)).toBe(true);

    const lineage = await getUtteranceLineage(t.ctx, stored.utteranceId);
    expect(lineage.session.mode).toBe("demo");
    expect(lineage.sourceAsset?.sha256).toBe(stored.source.sha256);
    expect(lineage.transcripts.map((transcript) => transcript.type)).toEqual(["asr"]);
    expect(lineage.batches).toHaveLength(1);
    expect(lineage.batches[0]!.batch.dataMode).toBe("demo");
    const lineageTranslations = lineage.batches[0]!.translations;
    expect(lineageTranslations.map((translation) => translation.conditionKey).sort()).toEqual(["default", "preservation"]);
    for (const translation of lineageTranslations) {
      expect(translation.provenance.modelConfig).not.toBeNull();
      expect(translation.provenance.promptVersion?.promptText).toBeTruthy();
      expect(translation.syntheses).toHaveLength(1);
      expect(translation.syntheses[0]!.sourceText).toBe(translation.translatedText);
      expect(await t.storage.exists(translation.syntheses[0]!.asset.storageKey)).toBe(true);
    }

    // Nothing of this is research data.
    const [sessionRow] = await t.testDb.db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(sessionRow!.mode).toBe("demo");
    const researchBatches = await t.testDb.db
      .select()
      .from(processingBatches)
      .where(eq(processingBatches.dataMode, "research"));
    expect(researchBatches.filter((row) => row.studyId === env.study.id)).toHaveLength(0);

    // A second recording reuses the batch of the session.
    const again = await recordAndRun(env, session.id);
    expect(again.result.processingBatchId).toBe(result.processingBatchId);
    expect(again.result.turnIndex).toBe(1);
    // Running the same recording again creates nothing new.
    const repeated = await runDemoPipeline(t.ctx, { sessionId: session.id, utteranceId: stored.utteranceId });
    expect(repeated.conditions[0]!.translation.translationId).toBe(result.conditions[0]!.translation.translationId);
    expect(await t.testDb.db.select().from(modelRuns).where(eq(modelRuns.processingBatchId, batch!.id))).toHaveLength(10);
  });

  it("runs stage by stage without repeating a model call", async () => {
    const { session } = await startDemo(env);
    const stored = await createDemoUtterance(t.ctx, session, { data: tone() });
    const run = (stage: "asr" | "translation" | "tts") =>
      runDemoPipeline(t.ctx, { sessionId: session.id, utteranceId: stored.utteranceId, stage });

    // A later stage never starts the transcription by itself.
    const early = await run("translation");
    expect(early.asr.status).toBe("failed");
    expect(early.asr.error?.reason).toBe("no_transcript");
    expect(early.conditions.every((condition) => condition.translation.status === "skipped")).toBe(true);

    const first = await run("asr");
    expect(first.ok).toBe(true);
    expect(first.asr.text).toContain("[mock-transkriptio");
    expect(first.conditions.every((condition) => condition.translation.status === "skipped")).toBe(true);

    const second = await run("translation");
    expect(second.ok).toBe(true);
    expect(second.asr.transcriptRevisionId).toBe(first.asr.transcriptRevisionId);
    expect(second.conditions.every((condition) => condition.translation.status === "succeeded")).toBe(true);
    expect(second.conditions.every((condition) => condition.synthesis.status === "skipped")).toBe(true);

    const third = await run("tts");
    expect(third.ok).toBe(true);
    expect(third.conditions.map((condition) => condition.translation.translationId)).toEqual(
      second.conditions.map((condition) => condition.translation.translationId),
    );
    expect(third.conditions.every((condition) => condition.synthesis.status === "succeeded")).toBe(true);

    const runs = await t.testDb.db.select().from(modelRuns).where(eq(modelRuns.processingBatchId, third.processingBatchId!));
    expect(runs.map((row) => row.stage).sort()).toEqual(["asr", "translation", "translation", "tts", "tts"]);
    const [batch] = await t.testDb.db
      .select()
      .from(processingBatches)
      .where(eq(processingBatches.id, third.processingBatchId!));
    expect(batch!.status).toBe("completed");
  });

  it("does not run a recording of another demo session", async () => {
    const first = await startDemo(env);
    const second = await startDemo(env);
    const stored = await createDemoUtterance(t.ctx, first.session, { data: tone() });
    await expectAppError(
      runDemoPipeline(t.ctx, { sessionId: second.session.id, utteranceId: stored.utteranceId }),
      "NOT_FOUND",
    );
  });

  it("runs with the mock configurations without touching the active ones", async () => {
    const before = await t.testDb.db.select().from(modelConfigs).where(eq(modelConfigs.studyId, env.study.id));
    const { session } = await startDemo(env);
    const { result } = await recordAndRun(env, session.id, { configs: { kind: "mock" } });
    expect(result.ok).toBe(true);
    expect(result.providerMode).toBe("mock");
    expect(result.asr.provenance?.configKey).toBe(MOCK_CONFIG_KEYS.asr);

    const after = await t.testDb.db.select().from(modelConfigs).where(eq(modelConfigs.studyId, env.study.id));
    const added = after.filter((config) => !before.some((row) => row.id === config.id));
    expect(added.map((config) => config.key).sort()).toEqual(Object.values(MOCK_CONFIG_KEYS).sort());
    expect(added.every((config) => config.status === "retired" && config.provider === "mock")).toBe(true);
    for (const row of before) {
      expect(after.find((config) => config.id === row.id)).toEqual(row);
    }
    // The stored mock configurations are reused.
    const next = await startDemo(env);
    await recordAndRun(env, next.session.id, { configs: { kind: "mock" } });
    expect(await t.testDb.db.select().from(modelConfigs).where(eq(modelConfigs.studyId, env.study.id))).toHaveLength(
      after.length,
    );
  });

  it("serves audio only to the demo session it belongs to", async () => {
    const mine = await startDemo(env);
    const other = await startDemo(env);
    const { stored, result } = await recordAndRun(env, mine.session.id);
    const ttsAssetId = result.conditions[0]!.synthesis.mediaAssetId!;

    const own = await getDemoMediaForStreaming(t.ctx, { sessionId: mine.session.id, mediaAssetId: ttsAssetId });
    expect(own.mimeType).toContain("audio");
    await getDemoMediaForStreaming(t.ctx, { sessionId: mine.session.id, mediaAssetId: stored.mediaAssetId });

    await expectAppError(
      getDemoMediaForStreaming(t.ctx, { sessionId: other.session.id, mediaAssetId: ttsAssetId }),
      "MEDIA_NOT_FOUND",
    );
    await expectAppError(
      getDemoMediaForStreaming(t.ctx, { sessionId: other.session.id, mediaAssetId: stored.mediaAssetId }),
      "MEDIA_NOT_FOUND",
    );
    // A research asset is never served, and a research session is never a caller.
    const research = await addUtterance(env, { mode: "research" });
    await expectAppError(
      getDemoMediaForStreaming(t.ctx, { sessionId: mine.session.id, mediaAssetId: research.media.id }),
      "MEDIA_NOT_FOUND",
    );
    await expectAppError(
      getDemoMediaForStreaming(t.ctx, { sessionId: research.session.id, mediaAssetId: research.media.id }),
      "MEDIA_NOT_FOUND",
    );
  });
});

describe("independent stages", () => {
  it("keeps the ASR result and the other condition when one translation fails", async () => {
    const env = await setupEnv(t);
    await retireConfig(env, env.ai.configs.translationPreserve.id);
    await insertConfig(env, {
      key: "translation_preserve",
      stage: "translation",
      conditionKey: "preservation",
      versionNumber: 2,
      promptText: "Failing preservation instruction.",
      parameters: { mockFail: "permanent" },
    });
    const { session } = await startDemo(env);
    const { stored, result } = await recordAndRun(env, session.id, { isAdmin: false });

    expect(result.ok).toBe(false);
    expect(result.asr.status).toBe("succeeded");
    const [normal, failing] = result.conditions;
    expect(normal).toMatchObject({ conditionKey: "default" });
    expect(normal!.translation.status).toBe("succeeded");
    expect(normal!.synthesis.status).toBe("succeeded");
    expect(failing!.translation.status).toBe("failed");
    expect(failing!.translation.error).toMatchObject({ code: "TRANSLATION_PROVIDER_ERROR", reason: "provider_error" });
    // A visitor gets the plain message only. An admin also gets the provider detail.
    expect(failing!.translation.error?.detail).toBeUndefined();
    expect(failing!.synthesis.status).toBe("skipped");

    const revisions = await t.testDb.db
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.id, result.asr.transcriptRevisionId!));
    expect(revisions).toHaveLength(1);
    const stored2 = await t.testDb.db
      .select()
      .from(translations)
      .where(eq(translations.sourceTranscriptRevisionId, result.asr.transcriptRevisionId!));
    expect(stored2).toHaveLength(1);
    const [batch] = await t.testDb.db
      .select()
      .from(processingBatches)
      .where(eq(processingBatches.id, result.processingBatchId!));
    expect(batch!.status).toBe("completed_with_errors");
    const lineage = await getUtteranceLineage(t.ctx, stored.utteranceId);
    expect(lineage.failedRuns.map((run) => run.stage)).toEqual(["translation"]);

    const forAdmin = await runDemoPipeline(t.adminCtx, {
      sessionId: session.id,
      utteranceId: stored.utteranceId,
      isAdmin: true,
    });
    expect(forAdmin.conditions[1]!.translation.error?.detail).toBeTruthy();
    expect(forAdmin.conditions[0]!.translation.translationId).toBe(normal!.translation.translationId);
  });

  it("reports a missing active configuration as a clear stage error", async () => {
    const env = await setupEnv(t);
    await retireConfig(env, env.ai.configs.ttsBaseline.id);
    await retireConfig(env, env.ai.configs.translationDefault.id);
    const { session } = await startDemo(env);
    const { result } = await recordAndRun(env, session.id);

    expect(result.asr.status).toBe("succeeded");
    const [missing, present] = result.conditions;
    expect(missing).toMatchObject({ conditionKey: "default", label: "Default translation" });
    expect(missing!.translation.status).toBe("failed");
    expect(missing!.translation.error).toMatchObject({ code: "CONFIGURATION_MISSING", reason: "configuration_missing" });
    expect(missing!.translation.error?.message).toContain('"translation_default"');
    expect(missing!.translation.error?.message).toContain("AI Pipeline");
    expect(present!.translation.status).toBe("succeeded");
    expect(present!.synthesis.status).toBe("failed");
    expect(present!.synthesis.error?.message).toContain('"tts_baseline"');
    expect(await t.testDb.db.select().from(syntheses).where(eq(syntheses.processingBatchId, result.processingBatchId!))).toHaveLength(0);
  });

  it("fails only the ASR stage, without a batch, when no ASR configuration is active", async () => {
    const env = await setupEnv(t, { configs: false });
    const { session } = await startDemo(env);
    const { stored, result } = await recordAndRun(env, session.id);
    expect(result.asr.status).toBe("failed");
    expect(result.asr.error).toMatchObject({ code: "CONFIGURATION_MISSING" });
    expect(result.processingBatchId).toBeNull();
    expect(result.conditions).toHaveLength(2);
    expect(result.conditions.every((condition) => condition.translation.status === "skipped")).toBe(true);
    // The recording is kept.
    expect(await t.storage.exists(stored.storageKey)).toBe(true);
  });

  it("says plainly that the OpenAI API key is not configured", async () => {
    const study = await insertStudy(t.testDb.db, { settingsJson: { sourceLanguage: "fi", targetLanguage: "en" } });
    const { protocol, tasks } = await insertPublishedProtocol(t.testDb.db, { studyId: study.id });
    const ai = await insertActiveAiConfigs(t.testDb.db, { studyId: study.id, provider: "openai" });
    const env: TestEnv = { t, study, protocol, tasks, ai };
    const { session } = await startDemo(env);
    const { stored, result } = await recordAndRun(env, session.id);
    expect(result.isMock).toBe(false);
    expect(result.asr.status).toBe("failed");
    expect(result.asr.error).toMatchObject({ code: "CONFIGURATION_MISSING", reason: "provider_not_configured" });
    expect(result.asr.error?.message).toContain("The OpenAI API key is not configured on the server");
    // The failed attempt is a visible model run, and the source recording is untouched.
    const lineage = await getUtteranceLineage(t.ctx, stored.utteranceId);
    expect(lineage.failedRuns).toHaveLength(1);
    expect(lineage.sourceAsset?.id).toBe(stored.mediaAssetId);
  });
});

// Defect E2E-2. The provider registry lives for the whole process and can be
// created by another copy of the code than the one that runs the pipeline (the
// production web build holds several copies of @dialect/domain). Its errors
// then are not instances of this copy's AppError class.
describe("errors made by another copy of the error classes", () => {
  class AppErrorCopy extends Error {
    readonly code = "CONFIGURATION_MISSING";
    readonly details = { provider: "openai" };
    constructor() {
      super("No OpenAI API key is configured. Set OPENAI_API_KEY on the server to use the openai provider.");
      this.name = "AppError";
    }
  }

  it("still says plainly that the OpenAI API key is not configured", async () => {
    const study = await insertStudy(t.testDb.db, { settingsJson: { sourceLanguage: "fi", targetLanguage: "en" } });
    const { protocol, tasks } = await insertPublishedProtocol(t.testDb.db, { studyId: study.id });
    const ai = await insertActiveAiConfigs(t.testDb.db, { studyId: study.id, provider: "openai" });
    const env: TestEnv = { t, study, protocol, tasks, ai };
    const { session } = await startDemo(env);
    const stored = await createDemoUtterance(t.ctx, { id: session.id }, { data: tone(), declaredMimeType: "audio/wav" });

    const fail = () => {
      throw new AppErrorCopy();
    };
    const providers = Object.create(t.ctx.providers) as typeof t.ctx.providers;
    providers.transcriber = fail;
    providers.translator = fail;
    providers.synthesizer = fail;
    expect(new AppErrorCopy()).not.toBeInstanceOf(AppError);

    const result = await runDemoPipeline({ ...t.ctx, providers }, { sessionId: session.id, utteranceId: stored.utteranceId });
    expect(result.asr.status).toBe("failed");
    expect(result.asr.error).toMatchObject({ code: "CONFIGURATION_MISSING", reason: "provider_not_configured" });
    expect(result.asr.error?.message).toContain("The OpenAI API key is not configured on the server");
  });
});

describe("cost limits of Demo Mode", () => {
  it("does not call a step again after three failed attempts for the same recording", async () => {
    const env = await setupEnv(t);
    await retireConfig(env, env.ai.configs.translationPreserve.id);
    const failing = await insertConfig(env, {
      key: "translation_preserve",
      stage: "translation",
      conditionKey: "preservation",
      versionNumber: 2,
      promptText: "Failing preservation instruction.",
      parameters: { mockFail: "permanent" },
    });
    const { session } = await startDemo(env);
    const { stored, result } = await recordAndRun(env, session.id, { isAdmin: false });
    expect(result.conditions[1]!.translation.status).toBe("failed");

    const failedRuns = async () =>
      (
        await t.testDb.db
          .select()
          .from(modelRuns)
          .where(and(eq(modelRuns.modelConfigId, failing.modelConfigId), eq(modelRuns.status, "failed")))
      ).length;
    const retry = () =>
      runDemoPipeline(t.ctx, { sessionId: session.id, utteranceId: stored.utteranceId, stage: "translation" });

    expect(MAX_STEP_ATTEMPTS).toBe(3);
    expect(await failedRuns()).toBe(1);
    expect((await retry()).conditions[1]!.translation.error?.reason).toBe("provider_error");
    expect((await retry()).conditions[1]!.translation.error?.reason).toBe("provider_error");
    expect(await failedRuns()).toBe(3);

    // The fourth and every later request makes no provider call.
    for (let index = 0; index < 3; index += 1) {
      const refused = await retry();
      expect(refused.conditions[1]!.translation).toMatchObject({
        status: "failed",
        error: { code: "RATE_LIMITED", reason: "attempt_limit", retryable: false },
      });
      // The condition that succeeded is still returned from its stored output.
      expect(refused.conditions[0]!.translation.status).toBe("succeeded");
    }
    expect(await failedRuns()).toBe(3);

    // A new recording starts with a fresh count.
    const again = await recordAndRun(env, session.id, { isAdmin: false });
    expect(again.result.conditions[1]!.translation.error?.reason).toBe("provider_error");
    expect(await failedRuns()).toBe(4);
  });

  it("refuses a visitor's run when the daily budget of the study is used up", async () => {
    // A provider that is not the mock provider: its calls count as paid calls.
    const env = await setupEnv(t, { provider: RESEARCH_TEST_PROVIDER });
    await setSettings(env, { demoPublic: true, allowNewSessions: true, demoDailyRunLimit: 2 });
    const visitor = await startDemoSession(t.ctx, { acknowledged: true, isAdmin: false, studySlug: env.study.slug });
    const hits = async () =>
      (await t.testDb.db.select().from(rateLimitHits).where(like(rateLimitHits.bucketKey, demoBudgetBucket(env.study.id)))).length;

    const first = await recordAndRun(env, visitor.session.id, { isAdmin: false, stage: "asr" });
    expect(first.result.asr.status).toBe("succeeded");
    expect(await hits()).toBe(1);
    // The later stages and a repeated request of the same recording are not counted again.
    await runDemoPipeline(t.ctx, { sessionId: visitor.session.id, utteranceId: first.stored.utteranceId, stage: "translation" });
    await runDemoPipeline(t.ctx, { sessionId: visitor.session.id, utteranceId: first.stored.utteranceId, stage: "asr" });
    expect(await hits()).toBe(1);

    await recordAndRun(env, visitor.session.id, { isAdmin: false });
    expect(await hits()).toBe(2);

    // The third recording of the day is refused before any provider call.
    const third = await createDemoUtterance(t.ctx, visitor.session, { data: tone() });
    const error = await expectAppError(
      runDemoPipeline(t.ctx, { sessionId: visitor.session.id, utteranceId: third.utteranceId, isAdmin: false }),
      "RATE_LIMITED",
    );
    expect(error.message).toContain("limit of 2 runs in 24 hours");
    expect(error.details).toMatchObject({ reason: "demo_daily_budget", limit: 2 });
    expect(await t.testDb.db.select().from(modelRuns).where(eq(modelRuns.sourceEntityId, third.utteranceId))).toHaveLength(0);

    // A signed-in researcher is not counted and not refused.
    const admin = await runDemoPipeline(t.adminCtx, {
      sessionId: visitor.session.id,
      utteranceId: third.utteranceId,
      stage: "asr",
      isAdmin: true,
    });
    expect(admin.asr.status).toBe("succeeded");
    expect(await hits()).toBe(2);

    // One day later the budget is available again.
    t.clock.advance(24 * 3600 * 1000 + 1000);
    const later = await recordAndRun(env, visitor.session.id, { isAdmin: false, stage: "asr" });
    expect(later.result.asr.status).toBe("succeeded");
  });

  it("uses 200 runs a day when the setting is missing, and does not count mock provider runs", async () => {
    const env = await setupEnv(t);
    expect(demoSettings(env.study).demoDailyRunLimit).toBe(200);
    // A value outside 1 to 100000 is not used.
    await setSettings(env, { demoDailyRunLimit: 0 });
    const [changed] = await t.testDb.db.select().from(studies).where(eq(studies.id, env.study.id));
    expect(demoSettings(changed!).demoDailyRunLimit).toBe(200);
    await setSettings(env, { demoPublic: true, allowNewSessions: true, demoDailyRunLimit: 1 });
    await t.testDb.db.insert(rateLimitHits).values({ bucketKey: demoBudgetBucket(env.study.id), createdAt: t.clock.now() });
    const visitor = await startDemoSession(t.ctx, { acknowledged: true, isAdmin: false, studySlug: env.study.slug });
    // The configurations of this study use the mock provider, which costs nothing.
    const { result } = await recordAndRun(env, visitor.session.id, { isAdmin: false });
    expect(result.isMock).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("device data of a demo recording", () => {
  it("stores the device class and no device identifier", async () => {
    const env = await setupEnv(t);
    const { session } = await startDemo(env);
    const stored = await createDemoUtterance(t.ctx, session, {
      data: tone(),
      captureMetadata: {
        deviceLabel: "Liisa Lahtisen Bluetooth Headset",
        actualTrackSettings: { sampleRate: 48000, deviceId: "device-id-secret", groupId: "group-id-secret" },
        requestedConstraints: { channelCount: 1, deviceId: { ideal: "device-id-secret" } },
      },
    });
    const [row] = await t.testDb.db.select().from(mediaAssets).where(eq(mediaAssets.id, stored.mediaAssetId));
    expect(row!.metadataJson).toMatchObject({
      actualTrackSettings: { sampleRate: 48000 },
      requestedConstraints: { channelCount: 1 },
      declared: { deviceLabel: "bluetooth" },
    });
    expect(JSON.stringify(row)).not.toMatch(/device-id-secret|group-id-secret|Lahtisen/);
  });
});

describe("purgeDemoSession", () => {
  it("removes the rows and stored audio of one demo session only", async () => {
    const env = await setupEnv(t);
    const kept = await startDemo(env);
    const removed = await startDemo(env);
    const keptRun = await recordAndRun(env, kept.session.id);
    const removedRun = await recordAndRun(env, removed.session.id);
    await recordAndRun(env, removed.session.id);
    const research = await addUtterance(env, { mode: "research" });
    const test = await addUtterance(env, { mode: "test" });

    const removedKeys = (
      await t.testDb.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, removed.session.id))
    ).map((asset) => asset.storageKey);
    const removedTts = await t.testDb.db
      .select({ key: mediaAssets.storageKey })
      .from(syntheses)
      .innerJoin(mediaAssets, eq(mediaAssets.id, syntheses.mediaAssetId))
      .where(eq(syntheses.processingBatchId, removedRun.result.processingBatchId!));
    expect(removedTts).toHaveLength(4);
    for (const key of [...removedKeys, ...removedTts.map((row) => row.key)]) {
      expect(await t.storage.exists(key)).toBe(true);
    }

    // Queue jobs without a batch that name a recording of each session.
    await t.testDb.db.insert(jobs).values([
      { type: "derive_wav", status: "failed", payloadJson: { mediaAssetId: removedRun.stored.mediaAssetId }, idempotencyKey: `purge-test:removed:${removed.session.id}` },
      { type: "derive_wav", status: "failed", payloadJson: { mediaAssetId: keptRun.stored.mediaAssetId }, idempotencyKey: `purge-test:kept:${kept.session.id}` },
      { type: "asr", status: "failed", payloadJson: { utteranceId: research.utterance.id }, idempotencyKey: `purge-test:research:${research.session.id}` },
    ]);

    const result = await purgeDemoSession(t.adminCtx, removed.session.id);
    const purgeTestJobs = await t.testDb.db.select({ key: jobs.idempotencyKey }).from(jobs).where(like(jobs.idempotencyKey, "purge-test:%"));
    expect(purgeTestJobs.map((row) => row.key).sort()).toEqual(
      [`purge-test:kept:${kept.session.id}`, `purge-test:research:${research.session.id}`].sort(),
    );
    expect(result.deleted).toMatchObject({
      sessions: 1,
      utterances: 2,
      task_presentations: 1,
      translations: 4,
      syntheses: 4,
      model_runs: 10,
      processing_batches: 1,
    });
    expect(result.storageObjectsFailed).toBe(0);
    expect(result.storageObjectsRemoved).toBe(6);
    for (const key of [...removedKeys, ...removedTts.map((row) => row.key)]) {
      expect(await t.storage.exists(key)).toBe(false);
    }
    expect(await t.testDb.db.select().from(sessions).where(eq(sessions.id, removed.session.id))).toHaveLength(0);
    expect(
      await t.testDb.db.select().from(processingBatches).where(eq(processingBatches.id, removedRun.result.processingBatchId!)),
    ).toHaveLength(0);

    // The other demo session is complete, and so are the research and test sessions.
    const lineage = await getUtteranceLineage(t.ctx, keptRun.stored.utteranceId);
    expect(lineage.batches[0]!.translations).toHaveLength(2);
    expect(await t.storage.exists(keptRun.stored.storageKey)).toBe(true);
    expect(await t.testDb.db.select().from(sessions).where(eq(sessions.id, research.session.id))).toHaveLength(1);
    expect(await t.testDb.db.select().from(sessions).where(eq(sessions.id, test.session.id))).toHaveLength(1);

    const audit = await t.testDb.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, removed.session.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "test_data.reset", entityType: "session", actorLabel: "admin" });
    expect(audit[0]!.afterJson).toMatchObject({ scope: "demo_session", participantCode: removed.session.participantCode });
  });

  it("refuses a research session and a test session", async () => {
    const env = await setupEnv(t);
    const research = await addUtterance(env, { mode: "research" });
    const test = await addUtterance(env, { mode: "test" });
    const researchError = await expectAppError(purgeDemoSession(t.adminCtx, research.session.id), "FORBIDDEN");
    expect(researchError.message).toContain("research");
    await expectAppError(purgeDemoSession(t.adminCtx, test.session.id), "FORBIDDEN");
    await expectAppError(purgeDemoSession(t.adminCtx, "00000000-0000-4000-8000-000000000000"), "NOT_FOUND");
    expect(await t.testDb.db.select().from(utterances).where(eq(utterances.id, research.utterance.id))).toHaveLength(1);
    expect(await t.testDb.db.select().from(utterances).where(eq(utterances.id, test.utterance.id))).toHaveLength(1);
  });

  it("keeps an ended demo session when demo data is persisted, and purges leftovers only when it is not", async () => {
    const env = await setupEnv(t);
    const ended = await startDemo(env);
    const { stored } = await recordAndRun(env, ended.session.id);
    await completeDemoSession(t.ctx, ended.session.id);
    const [row] = await t.testDb.db.select().from(sessions).where(eq(sessions.id, ended.session.id));
    expect(row).toMatchObject({ status: "completed", mode: "demo", tokenHash: null });
    expect(await findDemoSessionByToken(t.ctx, ended.token)).toBeNull();
    await expectAppError(createDemoUtterance(t.ctx, ended.session, { data: tone() }), "SESSION_EXPIRED");

    const active = await startDemo(env);
    await expectAppError(purgeLeftoverDemoSessions(t.adminCtx, { studySlug: env.study.slug }), "INVALID_STATE");

    await setSettings(env, { demoPersist: false });
    const leftovers = await listLeftoverDemoSessions(t.ctx, { studySlug: env.study.slug });
    expect(leftovers.map((session) => session.id)).toEqual([ended.session.id]);
    const purged = await purgeLeftoverDemoSessions(t.adminCtx, { studySlug: env.study.slug });
    expect(purged.sessions).toBe(1);
    expect(await t.storage.exists(stored.storageKey)).toBe(false);
    // A session that is still in use is not a leftover.
    expect(await t.testDb.db.select().from(sessions).where(eq(sessions.id, active.session.id))).toHaveLength(1);
  });
});

describe("pipeline test", () => {
  it("returns the five rows, writes test data and an audit row", async () => {
    const env = await setupEnv(t);
    const result = await runPipelineTest(t.adminCtx, { audio: { kind: "generated_tone" }, studySlug: env.study.slug });

    expect(result.rows.map((row) => [row.label, row.result])).toEqual([
      ["ASR", "PASS"],
      ["Default translation", "PASS"],
      ["Preserve translation", "PASS"],
      ["TTS", "PASS"],
      ["Storage", "PASS"],
    ]);
    expect(result.passed).toBe(true);
    expect(result.dataMode).toBe("test");
    expect(result.rows[0]).toMatchObject({ model: "mock / mock-asr", message: null });
    expect(result.rows.every((row) => typeof row.latencyMs === "number")).toBe(true);
    expect(result.rows[4]!.model).toBe("memory storage");
    expect(result.transcriptExcerpt).toContain("[mock-transkriptio");

    const [session] = await t.testDb.db.select().from(sessions).where(eq(sessions.id, result.sessionId));
    expect(session).toMatchObject({ mode: "test", status: "completed", tokenHash: null });
    const [batch] = await t.testDb.db
      .select()
      .from(processingBatches)
      .where(eq(processingBatches.id, result.processingBatchId!));
    expect(batch).toMatchObject({ dataMode: "test", name: `pipeline-test-${result.participantCode}` });
    const researchSessions = (await t.testDb.db.select().from(sessions).where(eq(sessions.studyId, env.study.id))).filter(
      (row) => row.mode === "research",
    );
    expect(researchSessions).toHaveLength(0);

    const audit = await t.testDb.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, result.sessionId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "pipeline_test.run", actorLabel: "admin" });
    expect((audit[0]!.afterJson as { transcriptExcerpt: unknown }).transcriptExcerpt).toBeNull();

    const last = await getLastPipelineTest(t.ctx);
    expect(last?.sessionId).toBe(result.sessionId);
    expect(last?.rows).toHaveLength(5);
  });

  it("accepts a recorded clip and refuses an unusable one without leaving a session", async () => {
    const env = await setupEnv(t);
    const result = await runPipelineTest(t.adminCtx, {
      audio: { kind: "recording", data: tone(800), declaredMimeType: "audio/wav" },
      studySlug: env.study.slug,
    });
    expect(result.passed).toBe(true);
    expect(result.source).toBe("recording");

    const before = await t.testDb.db.select().from(sessions).where(eq(sessions.studyId, env.study.id));
    await expectAppError(
      runPipelineTest(t.adminCtx, {
        audio: { kind: "recording", data: Buffer.from("no audio") },
        studySlug: env.study.slug,
      }),
      "INVALID_AUDIO",
    );
    // Longer than the limit of a pipeline test recording.
    await expectAppError(
      runPipelineTest(t.adminCtx, {
        audio: {
          kind: "recording",
          data: generateSineWav({
            durationMs: (demoSchemas.PIPELINE_TEST_MAX_RECORDING_SECONDS + 10) * 1000,
            sampleRateHz: 8000,
            frequencyHz: 440,
          }),
        },
        studySlug: env.study.slug,
      }),
      "INVALID_AUDIO",
    );
    expect(await t.testDb.db.select().from(sessions).where(eq(sessions.studyId, env.study.id))).toHaveLength(before.length);
  });

  it("reports FAIL with a safe message when the provider is not configured", async () => {
    const study = await insertStudy(t.testDb.db, { settingsJson: { sourceLanguage: "fi", targetLanguage: "en" } });
    await insertPublishedProtocol(t.testDb.db, { studyId: study.id });
    await insertActiveAiConfigs(t.testDb.db, { studyId: study.id, provider: "openai", models: { asr: "some-asr-model" } });

    const result = await runPipelineTest(t.adminCtx, { audio: { kind: "generated_tone" }, studySlug: study.slug });
    expect(result.passed).toBe(false);
    expect(result.isMock).toBe(false);
    const [asr, translationDefault, translationPreserve, tts, storage] = result.rows;
    expect(asr).toMatchObject({ result: "FAIL", errorCode: "CONFIGURATION_MISSING", model: "openai / some-asr-model" });
    expect(asr!.message).toContain("The OpenAI API key is not configured on the server");
    expect(asr!.message).not.toMatch(/sk-|stack|at .*\(/);
    expect(translationDefault).toMatchObject({ result: "FAIL" });
    expect(translationDefault!.message).toContain("transcription did not succeed");
    expect(translationPreserve).toMatchObject({ result: "FAIL" });
    expect(tts).toMatchObject({ result: "FAIL" });
    expect(storage).toMatchObject({ result: "PASS" });

    // The same server passes with the mock option, and the active configurations stay as they are.
    const mock = await runPipelineTest(t.adminCtx, {
      audio: { kind: "generated_tone" },
      provider: "mock",
      studySlug: study.slug,
    });
    expect(mock.passed).toBe(true);
    expect(mock.isMock).toBe(true);
    const active = (await t.testDb.db.select().from(modelConfigs).where(eq(modelConfigs.studyId, study.id))).filter(
      (config) => config.status === "active",
    );
    expect(active).toHaveLength(4);
    expect(active.every((config) => config.provider === "openai")).toBe(true);
  });

  it("refuses the mock option when the mock provider is disabled", async () => {
    const env = await setupEnv(t);
    const { createProviderRegistry } = await import("@dialect/ai");
    const ctx = { ...t.adminCtx, providers: createProviderRegistry({ allowMock: false }) };
    await expectAppError(
      runPipelineTest(ctx, { audio: { kind: "generated_tone" }, provider: "mock", studySlug: env.study.slug }),
      "CONFIGURATION_MISSING",
    );
  });
});
