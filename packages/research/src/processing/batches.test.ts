import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  adminAuditLog,
  aiPromptVersions,
  isImmutableRecordError,
  jobs,
  modelConfigs,
  modelRuns,
  processingBatches,
  studies,
  syntheses,
  transcriptRevisions,
  translations,
} from "@dialect/db";
import { insertTranscriptWithRevision } from "@dialect/db/testing-builders";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  cancelBatch,
  createBatch,
  getBatch,
  listBatchJobs,
  listBatches,
  previewBatch,
  retryFailedJobs,
  startBatch,
} from "./batches";
import { getUtteranceLineage } from "./lineage";
import {
  RESEARCH_TEST_PROVIDER,
  addUtterance,
  drain,
  insertConfig,
  retireConfig,
  setupEnv,
  setupResearchEnv,
  type TestEnv,
} from "./test-helpers";

// These tests run whole batches (selection, queue, three model stages, real
// audio bytes) against a database. The default of 5 seconds per test is too
// short when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestServiceContext;

beforeAll(async () => {
  t = await createTestServiceContext();
});
afterAll(async () => {
  await t.cleanup();
});

const db = () => t.testDb.db;
const ABC = {
  asr: { text: "Minä en oikeastaan tiedä." },
  human_dialect: { text: "Mie en oikeestaan tiiä.", verified: true },
  normalized: { text: "Minä en oikeastaan tiedä.", verified: true },
} as const;

let nameCounter = 0;
const batchName = (label: string) => `${label}-${(nameCounter += 1)}`;

async function threeUtterances(env: TestEnv) {
  return [
    await addUtterance(env, { transcripts: { ...ABC, human_dialect: { text: "Mie en oikeestaan tiiä yks.", verified: true } } }),
    await addUtterance(env, { transcripts: { ...ABC, human_dialect: { text: "Mie en oikeestaan tiiä kaks.", verified: true } } }),
    await addUtterance(env, { transcripts: { ...ABC, human_dialect: { text: "Mie en oikeestaan tiiä kolme.", verified: true } } }),
  ];
}

describe("full batch", () => {
  it("produces the full matrix with complete lineage, one voice and one TTS configuration", async () => {
    const env = await setupResearchEnv(t);
    const utterances = await threeUtterances(env);

    const preview = await previewBatch(t.adminCtx, { studyId: env.study.id });
    expect(preview).toMatchObject({
      dataMode: "research",
      utteranceCount: 3,
      sessionCount: 3,
      sourceTranscriptCounts: { asr: 3, human_dialect: 3, normalized: 3 },
      estimatedJobCounts: { asr: 0, translation: 18, tts: 18, total: 36 },
    });
    expect(await db().select().from(processingBatches).where(eq(processingBatches.studyId, env.study.id))).toHaveLength(0);

    const draft = await createBatch(t.adminCtx, { studyId: env.study.id, name: batchName("pilot"), description: "First run" });
    expect(draft).toMatchObject({ status: "draft", dataMode: "research", utteranceCount: 3, createdByLabel: "admin" });
    expect(draft.configuration.selection).toMatchObject({
      mode: ["research"],
      completedSessionsOnly: true,
      verifiedTranscriptsOnly: true,
      excludeFlagged: true,
      excludeExcluded: true,
    });
    expect(draft.configuration.translations.map((config) => [config.key, config.promptText])).toEqual([
      ["translation_default", env.ai.prompts.translationDefault.promptText],
      ["translation_preserve", env.ai.prompts.translationPreserve.promptText],
    ]);
    expect(draft.configuration.tts.map((config) => config.parameters.voice)).toEqual(["mock-voice"]);
    expect(draft.jobCounts.total).toBe(0);

    const started = await startBatch(t.adminCtx, draft.id);
    expect(started.status).toBe("queued");
    expect(started.startedAt).not.toBeNull();
    expect(started.jobCounts).toMatchObject({ queued: 18, total: 18 });

    expect(await drain(t.ctx)).toBe(36);

    const done = await getBatch(t.adminCtx, draft.id);
    expect(done.status).toBe("completed");
    expect(done.completedAt).not.toBeNull();
    expect(done.jobCounts).toMatchObject({ succeeded: 36, failed: 0, total: 36 });
    expect(done.outputCounts).toEqual({ asrRevisions: 0, translations: 18, syntheses: 18 });
    expect(done.modelRunCounts).toEqual({ succeeded: 36, failed: 0, running: 0 });
    expect(done.estimatedCost).toBeNull();

    // 3 utterances x 3 transcript types x 2 conditions, one synthesis each.
    const batchTranslations = await db().select().from(translations).where(eq(translations.processingBatchId, draft.id));
    expect(batchTranslations).toHaveLength(18);
    const batchSyntheses = await db().select().from(syntheses).where(eq(syntheses.processingBatchId, draft.id));
    expect(batchSyntheses).toHaveLength(18);
    expect(new Set(batchSyntheses.map((row) => row.translationId)).size).toBe(18);

    // Spec 22: the same voice, model and configuration for every condition.
    expect(new Set(batchSyntheses.map((row) => row.voiceKey))).toEqual(new Set(["mock-voice"]));
    const ttsRuns = await db()
      .select()
      .from(modelRuns)
      .where(and(eq(modelRuns.processingBatchId, draft.id), eq(modelRuns.stage, "tts")));
    expect(new Set(ttsRuns.map((run) => run.modelConfigId))).toEqual(new Set([env.ai.configs.ttsBaseline.id]));
    expect(new Set(ttsRuns.map((run) => run.requestedModel))).toEqual(new Set(["mock-tts"]));
    expect(new Set(ttsRuns.map((run) => run.inputManifestJson.effectiveInstruction))).toEqual(
      new Set(["Speak the text naturally."]),
    );

    // Lineage of one utterance answers every question of spec 158.
    const u = utterances[1]!;
    const lineage = await getUtteranceLineage(t.adminCtx, u.utterance.id);
    expect(lineage.session).toMatchObject({ id: u.session.id, participantCode: u.session.participantCode, mode: "research" });
    expect(lineage.utterance).toMatchObject({ id: u.utterance.id, promptSnapshot: u.utterance.promptSnapshot });
    expect(lineage.task).toMatchObject({ taskPresentationId: u.presentation.id, promptSnapshot: u.presentation.promptSnapshot });
    expect(lineage.sourceAsset).toMatchObject({ id: u.media.id, sha256: u.media.sha256, kind: "source_audio" });
    expect(lineage.transcripts.map((transcript) => [transcript.label, transcript.revisions.length])).toEqual([
      ["A", 1],
      ["B", 1],
      ["C", 1],
    ]);
    expect(lineage.batches).toHaveLength(1);
    const group = lineage.batches[0]!;
    expect(group.batch).toMatchObject({ id: draft.id, name: draft.name });
    expect(group.translations.map((item) => `${item.source.transcriptLabel}:${item.conditionKey}`)).toEqual([
      "A:default",
      "A:preservation",
      "B:default",
      "B:preservation",
      "C:default",
      "C:preservation",
    ]);
    const item = group.translations.find(
      (candidate) => candidate.source.transcriptLabel === "B" && candidate.conditionKey === "preservation",
    )!;
    expect(item.source).toMatchObject({
      transcriptType: "human_dialect",
      transcriptRevisionId: u.revisions.human_dialect!.id,
      revisionNumber: 1,
    });
    expect(item.translatedText).toContain("Mie en oikeestaan tiiä kaks.");
    expect(item.provenance.promptVersion).toMatchObject({ key: "translation_preserve", versionNumber: 1 });
    expect(item.provenance.modelConfig).toMatchObject({ key: "translation_preserve", versionNumber: 1, modelId: "mock-translation" });
    expect(item.provenance.modelRun).toMatchObject({
      status: "succeeded",
      requestedModel: "mock-translation",
      appVersion: "test",
      processingBatchId: draft.id,
    });
    expect(item.provenance.modelRun.finishedAt).toBeInstanceOf(Date);
    expect(item.syntheses).toHaveLength(1);
    const synthesis = item.syntheses[0]!;
    expect(synthesis).toMatchObject({ voiceKey: "mock-voice", sourceText: item.translatedText, conditionKey: "baseline" });
    expect(synthesis.asset).toMatchObject({ kind: "tts_audio", container: "wav" });
    expect(synthesis.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(synthesis.provenance.modelConfig).toMatchObject({ key: "tts_baseline", modelId: "mock-tts" });
    expect(synthesis.provenance.modelRun).toMatchObject({ stage: "tts", appVersion: "test" });
    expect(synthesis.createdAt).toBeInstanceOf(Date);
    expect(lineage.failedRuns).toEqual([]);

    // Audit rows.
    const audit = await db().select().from(adminAuditLog).where(eq(adminAuditLog.entityId, draft.id));
    expect(audit.map((row) => [row.action, row.actorLabel])).toEqual([
      ["batch.create", "admin"],
      ["batch.start", "admin"],
    ]);

    // The list shows the batch with its counts and configuration summary.
    const list = await listBatches(t.adminCtx, { studyId: env.study.id });
    expect(list.total).toBe(1);
    expect(list.batches[0]).toMatchObject({
      id: draft.id,
      status: "completed",
      utteranceCount: 3,
      jobCounts: { succeeded: 36, failed: 0, total: 36 },
      config: {
        asr: null,
        translations: [
          { key: "translation_default", versionNumber: 1, conditionKey: "default" },
          { key: "translation_preserve", versionNumber: 1, conditionKey: "preservation" },
        ],
        tts: [{ key: "tts_baseline", versionNumber: 1 }],
      },
    });
  });

  it("keeps a second batch with a new prompt version next to the first, and freezes each configuration", async () => {
    const env = await setupResearchEnv(t);
    const [u] = await threeUtterances(env);
    const first = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("first"),
      selection: { utteranceIds: [u!.utterance.id] },
      transcriptTypes: ["human_dialect"],
    });

    // After the batch is created the researcher activates a new prompt version.
    await retireConfig(env, env.ai.configs.translationPreserve.id);
    await db()
      .update(aiPromptVersions)
      .set({ status: "retired", retiredAt: new Date() })
      .where(eq(aiPromptVersions.id, env.ai.prompts.translationPreserve.id));
    const [promptV2] = await db()
      .insert(aiPromptVersions)
      .values({
        studyId: env.study.id,
        key: "translation_preserve",
        stage: "translation",
        conditionKey: "preservation",
        versionNumber: 2,
        status: "active",
        activatedAt: new Date(),
        name: "Preservation v2",
        promptText: "Translate and keep register, stance and humour. Return only the translation.",
      })
      .returning();
    const [configV2] = await db()
      .insert(modelConfigs)
      .values({
        studyId: env.study.id,
        key: "translation_preserve",
        stage: "translation",
        conditionKey: "preservation",
        versionNumber: 2,
        status: "active",
        activatedAt: new Date(),
        provider: RESEARCH_TEST_PROVIDER,
        modelId: "mock-translation",
        promptVersionId: promptV2!.id,
      })
      .returning();

    // The first batch still uses what it was created with.
    await startBatch(t.adminCtx, first.id);
    await drain(t.ctx);
    const firstRows = await db().select().from(translations).where(eq(translations.processingBatchId, first.id));
    expect(firstRows).toHaveLength(2);
    const firstRuns = await db()
      .select()
      .from(modelRuns)
      .where(and(eq(modelRuns.processingBatchId, first.id), eq(modelRuns.conditionKey, "preservation"), eq(modelRuns.stage, "translation")));
    expect(firstRuns).toHaveLength(1);
    expect(firstRuns[0]).toMatchObject({
      promptVersionId: env.ai.prompts.translationPreserve.id,
      modelConfigId: env.ai.configs.translationPreserve.id,
    });
    expect(firstRuns[0]!.inputManifestJson.effectiveInstruction).toBe(env.ai.prompts.translationPreserve.promptText);

    // The configuration of a started batch cannot change (spec 54).
    await expect(startBatch(t.adminCtx, first.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const [stored] = await db().select().from(processingBatches).where(eq(processingBatches.id, first.id));
    const changed = db()
      .update(processingBatches)
      .set({ configurationSnapshotJson: { ...stored!.configurationSnapshotJson, targetLanguage: "sv" } })
      .where(eq(processingBatches.id, first.id));
    await expect(changed).rejects.toSatisfy(isImmutableRecordError);

    // A second batch uses the new version and leaves the first batch's rows alone.
    t.clock.advance(60_000);
    const second = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("second"),
      selection: { utteranceIds: [u!.utterance.id] },
      transcriptTypes: ["human_dialect"],
    });
    expect(second.config.translations.map((config) => [config.key, config.versionNumber])).toEqual([
      ["translation_default", 1],
      ["translation_preserve", 2],
    ]);
    await startBatch(t.adminCtx, second.id);
    await drain(t.ctx);

    const afterFirst = await db().select().from(translations).where(eq(translations.processingBatchId, first.id));
    expect(afterFirst).toEqual(firstRows);
    const secondRows = await db().select().from(translations).where(eq(translations.processingBatchId, second.id));
    expect(secondRows).toHaveLength(2);
    const [secondRun] = await db()
      .select()
      .from(modelRuns)
      .where(and(eq(modelRuns.processingBatchId, second.id), eq(modelRuns.conditionKey, "preservation"), eq(modelRuns.stage, "translation")));
    expect(secondRun).toMatchObject({ promptVersionId: promptV2!.id, modelConfigId: configV2!.id });
    const firstPreserve = firstRows.find((row) => row.conditionKey === "preservation")!;
    const secondPreserve = secondRows.find((row) => row.conditionKey === "preservation")!;
    expect(secondPreserve.translatedText).not.toBe(firstPreserve.translatedText);
    expect(secondPreserve.sourceTranscriptRevisionId).toBe(firstPreserve.sourceTranscriptRevisionId);

    const lineage = await getUtteranceLineage(t.adminCtx, u!.utterance.id);
    expect(lineage.batches.map((group) => [group.batch.id, group.translations.length])).toEqual([
      [first.id, 2],
      [second.id, 2],
    ]);
    expect(
      lineage.batches[1]!.translations.find((item) => item.conditionKey === "preservation")!.provenance.promptVersion,
    ).toMatchObject({ key: "translation_preserve", versionNumber: 2 });
  });

  it("runs ASR in the batch and translates the revision the batch produced, not later edits", async () => {
    const env = await setupResearchEnv(t);
    const u = await addUtterance(env, { transcripts: { asr: { text: "Vanha ASR tulos." }, human_dialect: { text: "Mie puhun.", verified: true } } });
    const batch = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("with-asr"),
      runAsr: true,
      transcriptTypes: ["asr", "human_dialect"],
      ttsModelConfigIds: [],
    });
    expect(batch.config.asr).toMatchObject({ key: "asr_default" });
    expect(batch.estimatedJobCounts).toEqual({ asr: 1, translation: 4, tts: 0 });
    const started = await startBatch(t.adminCtx, batch.id);
    // The translations of A wait for the batch's own ASR job.
    expect(started.jobCounts.total).toBe(3);

    // A human edit of B after the start does not change what the batch processes.
    const startRevision = u.revisions.human_dialect!;
    await db().update(transcriptRevisions).set({ isCurrent: false }).where(eq(transcriptRevisions.id, startRevision.id));
    await db().insert(transcriptRevisions).values({
      transcriptId: startRevision.transcriptId,
      revisionNumber: 2,
      text: "Mie puhun, korjattu.",
      createdByType: "researcher",
      isCurrent: true,
    });

    expect(await drain(t.ctx)).toBe(5);
    const done = await getBatch(t.adminCtx, batch.id);
    expect(done.status).toBe("completed");
    expect(done.outputCounts).toEqual({ asrRevisions: 1, translations: 4, syntheses: 0 });

    const lineage = await getUtteranceLineage(t.adminCtx, u.utterance.id);
    const asr = lineage.transcripts.find((transcript) => transcript.type === "asr")!;
    expect(asr.revisions.map((revision) => [revision.revisionNumber, revision.isCurrent, revision.provenance !== null])).toEqual([
      [1, false, false],
      [2, true, true],
    ]);
    expect(asr.revisions[1]!.provenance!.modelRun).toMatchObject({ stage: "asr", processingBatchId: batch.id });
    const rows = lineage.batches[0]!.translations;
    expect(rows.filter((row) => row.source.transcriptLabel === "A").map((row) => row.source.revisionNumber)).toEqual([2, 2]);
    expect(rows.filter((row) => row.source.transcriptLabel === "B").map((row) => row.source.transcriptRevisionId)).toEqual([
      startRevision.id,
      startRevision.id,
    ]);
  });
});

describe("selection", () => {
  it("excludes demo, test, flagged, excluded and incomplete sessions by default", async () => {
    const env = await setupResearchEnv(t);
    const good = await addUtterance(env, { transcripts: ABC });
    await addUtterance(env, { mode: "demo", transcripts: ABC });
    await addUtterance(env, { mode: "test", transcripts: ABC });
    await addUtterance(env, { session: { flagged: true }, transcripts: ABC });
    await addUtterance(env, { utterance: { flagged: true }, transcripts: ABC });
    await addUtterance(env, { session: { excluded: true, exclusionReason: "pilot" }, transcripts: ABC });
    await addUtterance(env, { utterance: { status: "excluded", exclusionReason: "noise" }, transcripts: ABC });
    await addUtterance(env, { sessionStatus: "recording", transcripts: ABC });
    await addUtterance(env, { sessionStatus: "withdrawn", transcripts: ABC });

    const preview = await previewBatch(t.adminCtx, { studyId: env.study.id });
    expect(preview.configuration.utteranceIds).toEqual([good.utterance.id]);

    const relaxed = await previewBatch(t.adminCtx, {
      studyId: env.study.id,
      selection: { completedSessionsOnly: false, excludeFlagged: false, excludeExcluded: false },
    });
    // Everything in research mode except the withdrawn session.
    expect(relaxed.utteranceCount).toBe(6);
  });

  it("never mixes data modes in one batch", async () => {
    const env = await setupResearchEnv(t);
    const research = await addUtterance(env, { transcripts: ABC });
    const demo = await addUtterance(env, { mode: "demo", transcripts: ABC });

    await expect(
      createBatch(t.adminCtx, {
        studyId: env.study.id,
        name: batchName("mixed"),
        selection: { utteranceIds: [research.utterance.id, demo.utterance.id] },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      previewBatch(t.adminCtx, { studyId: env.study.id, selection: { mode: "demo", sessionIds: [research.session.id] } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const batch = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("demo"),
      selection: { mode: "demo", verifiedTranscriptsOnly: false },
    });
    expect(batch.dataMode).toBe("demo");
    expect(batch.configuration.utteranceIds).toEqual([demo.utterance.id]);
  });

  it("skips unverified human transcripts when verifiedTranscriptsOnly is set", async () => {
    const env = await setupResearchEnv(t);
    const u = await addUtterance(env, {
      transcripts: {
        human_dialect: { text: "Varmennettu B.", verified: true },
        normalized: { text: "Varmentamaton C.", verified: false },
      },
    });
    const strict = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("strict"),
      transcriptTypes: ["human_dialect", "normalized"],
      ttsModelConfigIds: [],
    });
    expect(strict.estimatedJobCounts).toEqual({ asr: 0, translation: 2, tts: 0 });
    await startBatch(t.adminCtx, strict.id);
    await drain(t.ctx);
    const strictRows = await db().select().from(translations).where(eq(translations.processingBatchId, strict.id));
    expect(new Set(strictRows.map((row) => row.sourceTranscriptRevisionId))).toEqual(new Set([u.revisions.human_dialect!.id]));

    const relaxed = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("relaxed"),
      selection: { verifiedTranscriptsOnly: false },
      transcriptTypes: ["human_dialect", "normalized"],
      ttsModelConfigIds: [],
    });
    await startBatch(t.adminCtx, relaxed.id);
    await drain(t.ctx);
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, relaxed.id))).toHaveLength(4);
  });
});

describe("configuration", () => {
  it("fails with a clear error when no translation configuration is active", async () => {
    const env = await setupResearchEnv(t);
    await addUtterance(env, { transcripts: ABC });
    await retireConfig(env, env.ai.configs.translationDefault.id);

    await expect(createBatch(t.adminCtx, { studyId: env.study.id, name: batchName("no-config") })).rejects.toMatchObject({
      code: "CONFIGURATION_MISSING",
      message: expect.stringContaining('"translation_default"'),
    });
    // A retired configuration cannot be selected by id either.
    await expect(
      createBatch(t.adminCtx, {
        studyId: env.study.id,
        name: batchName("retired-config"),
        translationModelConfigIds: [env.ai.configs.translationDefault.id],
      }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_MISSING" });
    expect(await db().select().from(processingBatches).where(eq(processingBatches.studyId, env.study.id))).toHaveLength(0);
  });

  it("rejects a TTS configuration without a voice, two configurations with one condition and a duplicate name", async () => {
    const env = await setupResearchEnv(t);
    await addUtterance(env, { transcripts: ABC });
    const noVoice = await insertConfig(env, { key: "tts_no_voice", stage: "tts", conditionKey: "expressive" });
    await expect(
      createBatch(t.adminCtx, { studyId: env.study.id, name: batchName("no-voice"), ttsModelConfigIds: [noVoice.modelConfigId] }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_MISSING" });

    const sameCondition = await insertConfig(env, {
      key: "translation_default_b",
      stage: "translation",
      conditionKey: "default",
      promptText: "Translate differently.",
    });
    await expect(
      createBatch(t.adminCtx, {
        studyId: env.study.id,
        name: batchName("same-condition"),
        translationModelConfigIds: [env.ai.configs.translationDefault.id, sameCondition.modelConfigId],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const name = batchName("unique");
    await createBatch(t.adminCtx, { studyId: env.study.id, name });
    await expect(createBatch(t.adminCtx, { studyId: env.study.id, name })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createBatch(t.adminCtx, { studyId: env.study.id, name: "  " })).rejects.toThrow();
  });
});

describe("partial failure, retry and cancel", () => {
  it("becomes completed_with_errors and retries only the failed jobs", async () => {
    const env = await setupResearchEnv(t);
    const u1 = await addUtterance(env, { transcripts: { human_dialect: { text: "Ensimmäinen lause.", verified: true } } });
    const u2 = await addUtterance(env, { transcripts: { human_dialect: { text: "Toinen lause.", verified: true } } });
    // Fails on the first call for each input, without the queue retrying it.
    const flaky = await insertConfig(env, {
      key: "translation_flaky",
      stage: "translation",
      conditionKey: "flaky",
      parameters: { mockFail: "permanent", mockFailTimes: 1 },
      promptText: "Translate, sometimes.",
    });
    const batch = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("partial"),
      transcriptTypes: ["human_dialect"],
      translationModelConfigIds: [env.ai.configs.translationDefault.id, flaky.modelConfigId],
    });
    await startBatch(t.adminCtx, batch.id);
    await drain(t.ctx);

    const failed = await getBatch(t.adminCtx, batch.id);
    expect(failed.status).toBe("completed_with_errors");
    expect(failed.jobCounts).toMatchObject({ succeeded: 4, failed: 2, total: 6 });
    expect(failed.failedJobs).toHaveLength(2);
    expect(failed.failedJobs[0]).toMatchObject({ type: "translation", attempts: 1 });
    expect(failed.failedJobs[0]!.lastError).toContain("TRANSLATION_PROVIDER_ERROR");
    const failedPage = await listBatchJobs(t.adminCtx, batch.id, { status: "failed" });
    expect(failedPage.total).toBe(2);
    expect((await listBatchJobs(t.adminCtx, batch.id, { pageSize: 4 })).jobs).toHaveLength(4);

    const succeededBefore = await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.processingBatchId, batch.id), eq(jobs.status, "succeeded")));
    const runsBefore = await db()
      .select()
      .from(modelRuns)
      .where(and(eq(modelRuns.processingBatchId, batch.id), eq(modelRuns.status, "succeeded")));

    const retried = await retryFailedJobs(t.adminCtx, batch.id);
    expect(retried.retried).toBe(2);
    expect(retried.batch.status).toBe("running");
    // Two translations, then their two syntheses. Nothing else runs again.
    expect(await drain(t.ctx)).toBe(4);

    const done = await getBatch(t.adminCtx, batch.id);
    expect(done.status).toBe("completed");
    expect(done.jobCounts).toMatchObject({ succeeded: 8, failed: 0, total: 8 });
    expect(done.outputCounts).toMatchObject({ translations: 4, syntheses: 4 });
    const succeededAfter = await db().select().from(jobs).where(inArray(jobs.id, succeededBefore.map((job) => job.id)));
    expect(succeededAfter.map((job) => job.attempts).every((attempts) => attempts === 1)).toBe(true);
    const runsAfter = await db().select().from(modelRuns).where(inArray(modelRuns.id, runsBefore.map((run) => run.id)));
    expect(runsAfter).toHaveLength(runsBefore.length);

    // The failed attempts stay visible, as attempt 1 next to attempt 2.
    const flakyRuns = await db()
      .select()
      .from(modelRuns)
      .where(and(eq(modelRuns.processingBatchId, batch.id), eq(modelRuns.conditionKey, "flaky"), eq(modelRuns.stage, "translation")));
    expect(flakyRuns.map((run) => `${run.attemptNumber}:${run.status}`).sort()).toEqual([
      "1:failed",
      "1:failed",
      "2:succeeded",
      "2:succeeded",
    ]);
    const lineage = await getUtteranceLineage(t.adminCtx, u1.utterance.id);
    expect(lineage.failedRuns).toHaveLength(1);
    expect(lineage.failedRuns[0]).toMatchObject({ errorCode: "TRANSLATION_PROVIDER_ERROR", attemptNumber: 1 });
    expect(u2.utterance.id).not.toBe(u1.utterance.id);

    expect(await retryFailedJobs(t.adminCtx, batch.id)).toMatchObject({ retried: 0 });
    const audit = await db().select().from(adminAuditLog).where(eq(adminAuditLog.entityId, batch.id));
    expect(audit.map((row) => row.action)).toEqual(["batch.create", "batch.start", "batch.retry_failed", "batch.retry_failed"]);
  });

  it("cancels queued jobs, lets nothing new start and stays visible", async () => {
    const env = await setupResearchEnv(t);
    await threeUtterances(env);
    const batch = await createBatch(t.adminCtx, { studyId: env.study.id, name: batchName("cancelled"), transcriptTypes: ["human_dialect"] });
    await startBatch(t.adminCtx, batch.id);

    const cancelled = await cancelBatch(t.adminCtx, batch.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.jobCounts).toMatchObject({ cancelled: 6, queued: 0, total: 6 });
    expect(await drain(t.ctx)).toBe(0);
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).toHaveLength(0);

    await expect(retryFailedJobs(t.adminCtx, batch.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(startBatch(t.adminCtx, batch.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(cancelBatch(t.adminCtx, batch.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const list = await listBatches(t.adminCtx, { studyId: env.study.id });
    expect(list.batches.map((row) => [row.id, row.status])).toEqual([[batch.id, "cancelled"]]);
    const audit = await db().select().from(adminAuditLog).where(eq(adminAuditLog.entityId, batch.id));
    expect(audit.map((row) => row.action)).toEqual(["batch.create", "batch.start", "batch.cancel"]);
  });

  it("refuses to start a batch without any work", async () => {
    const env = await setupResearchEnv(t);
    await addUtterance(env);
    const batch = await createBatch(t.adminCtx, { studyId: env.study.id, name: batchName("empty") });
    await expect(startBatch(t.adminCtx, batch.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await getBatch(t.adminCtx, batch.id)).status).toBe("draft");
    await expect(createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("nothing"),
      selection: { dateFrom: "2000-01-01", dateTo: "2000-01-02" },
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("the mock provider and research data", () => {
  it("refuses a research batch whose configurations use the mock provider, and runs the same configurations on test data", async () => {
    const env = await setupEnv(t, { provider: "mock" });
    await addUtterance(env, { transcripts: ABC });
    const testUtterance = await addUtterance(env, { mode: "test", transcripts: ABC });

    for (const call of [
      () => previewBatch(t.adminCtx, { studyId: env.study.id }),
      () => createBatch(t.adminCtx, { studyId: env.study.id, name: batchName("mock-research") }),
      () => createBatch(t.adminCtx, { studyId: env.study.id, name: batchName("mock-research-asr"), runAsr: true, translationModelConfigIds: [], ttsModelConfigIds: [] }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: "CONFIGURATION_MISSING",
        message: expect.stringContaining("uses the mock provider"),
        details: { provider: "mock", dataMode: "research" },
      });
    }
    expect(await db().select().from(processingBatches).where(eq(processingBatches.studyId, env.study.id))).toHaveLength(0);

    const batch = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("mock-test"),
      selection: { mode: "test" },
    });
    await startBatch(t.adminCtx, batch.id);
    await drain(t.ctx);
    const done = await getBatch(t.adminCtx, batch.id);
    expect(done).toMatchObject({ status: "completed", dataMode: "test" });
    expect(done.outputCounts.translations).toBe(6);
    const runs = await db().select().from(modelRuns).where(eq(modelRuns.processingBatchId, batch.id));
    expect(runs.every((run) => run.provider === "mock" && run.status === "succeeded")).toBe(true);
    expect((await getUtteranceLineage(t.adminCtx, testUtterance.utterance.id)).batches).toHaveLength(1);
  });
});

describe("source and target language", () => {
  it("is required for every research batch, also for ASR only, and may be empty for an ASR-only test batch", async () => {
    const env = await setupResearchEnv(t);
    await db().update(studies).set({ settingsJson: {} }).where(eq(studies.id, env.study.id));
    await addUtterance(env, { transcripts: ABC });
    await addUtterance(env, { mode: "test", transcripts: ABC });
    const asrOnly = { studyId: env.study.id, runAsr: true, translationModelConfigIds: [], ttsModelConfigIds: [] };

    await expect(previewBatch(t.adminCtx, asrOnly)).rejects.toMatchObject({
      code: "CONFIGURATION_MISSING",
      message: expect.stringContaining("Set both on the Settings page"),
    });
    await expect(previewBatch(t.adminCtx, { studyId: env.study.id, selection: { mode: "test" } })).rejects.toMatchObject({
      code: "CONFIGURATION_MISSING",
    });
    const testPreview = await previewBatch(t.adminCtx, { ...asrOnly, selection: { mode: "test" } });
    expect(testPreview.configuration).toMatchObject({ sourceLanguage: "", targetLanguage: "" });

    await db().update(studies).set({ settingsJson: { sourceLanguage: "fi", targetLanguage: "en" } }).where(eq(studies.id, env.study.id));
    const preview = await previewBatch(t.adminCtx, asrOnly);
    expect(preview.configuration).toMatchObject({ sourceLanguage: "fi", targetLanguage: "en" });
  });
});

describe("normalized transcript written from an older dialect transcript", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute));
  const verified = { verifiedAt: new Date(), verifiedByLabel: "JS" };

  async function revision(utteranceId: string, type: "human_dialect" | "normalized", minute: number, derivedFromRevisionId?: string) {
    const { revision: row } = await insertTranscriptWithRevision(db(), {
      utteranceId,
      type,
      text: `${type} at ${minute}`,
      status: "verified",
      revision: { ...verified, createdAt: at(minute), ...(derivedFromRevisionId ? { derivedFromRevisionId } : {}) },
    });
    return row;
  }

  it("warns in the preview, without blocking, when B changed after C was derived or saved", async () => {
    const env = await setupResearchEnv(t);
    // 1: C copied from B revision 1, B changed afterwards.
    const copiedThenChanged = await addUtterance(env);
    const b1 = await revision(copiedThenChanged.utterance.id, "human_dialect", 1);
    await revision(copiedThenChanged.utterance.id, "normalized", 2, b1.id);
    await revision(copiedThenChanged.utterance.id, "human_dialect", 3);
    // 2: C without a recorded derivation, B changed after C was saved.
    const savedThenChanged = await addUtterance(env);
    await revision(savedThenChanged.utterance.id, "human_dialect", 1);
    await revision(savedThenChanged.utterance.id, "normalized", 2);
    await revision(savedThenChanged.utterance.id, "human_dialect", 3);
    // 3: C copied from the current B revision.
    const upToDate = await addUtterance(env);
    const current = await revision(upToDate.utterance.id, "human_dialect", 1);
    await revision(upToDate.utterance.id, "normalized", 2, current.id);
    // 4: C without a recorded derivation, saved after the last change of B.
    const savedLater = await addUtterance(env);
    await revision(savedLater.utterance.id, "human_dialect", 1);
    await revision(savedLater.utterance.id, "normalized", 2);

    const plan = { studyId: env.study.id, transcriptTypes: ["human_dialect", "normalized"] as const };
    const preview = await previewBatch(t.adminCtx, { ...plan, transcriptTypes: [...plan.transcriptTypes] });
    expect(preview.warnings).toEqual([
      {
        code: "normalized_from_older_dialect_revision",
        message: expect.stringContaining("For 1 utterance the normalized transcript (C) was copied from an earlier revision"),
        utteranceCount: 1,
        utteranceIds: [copiedThenChanged.utterance.id],
      },
      {
        code: "normalized_older_than_dialect_revision",
        message: expect.stringContaining("the dialect transcript (B) was changed after the normalized transcript (C) was last saved"),
        utteranceCount: 1,
        utteranceIds: [savedThenChanged.utterance.id],
      },
    ]);

    // C is not part of the batch: nothing to warn about.
    expect((await previewBatch(t.adminCtx, { studyId: env.study.id, transcriptTypes: ["human_dialect"] })).warnings).toEqual([]);

    // The warning does not block the batch, and the audit row records it.
    const batch = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: batchName("stale-normalized"),
      transcriptTypes: [...plan.transcriptTypes],
    });
    expect(batch.status).toBe("draft");
    const [audit] = await db()
      .select()
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.entityId, batch.id), eq(adminAuditLog.action, "batch.create")));
    expect(audit!.afterJson).toMatchObject({
      warnings: [
        { code: "normalized_from_older_dialect_revision", utteranceCount: 1 },
        { code: "normalized_older_than_dialect_revision", utteranceCount: 1 },
      ],
    });
  });
});
