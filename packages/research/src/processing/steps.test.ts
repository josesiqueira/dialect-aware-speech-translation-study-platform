import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mediaAssets, modelRuns, syntheses, transcriptRevisions, transcripts, translations } from "@dialect/db";
import { insertModelRun, insertProcessingBatch } from "@dialect/db/testing-builders";
import { generateSineWav, sha256OfBuffer } from "@dialect/storage";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  INTERRUPTED_RUN_ERROR_CODE,
  asrStepKey,
  attemptKey,
  describeSynthesizedAudio,
  runAsrStep,
  runSynthesisStep,
  runTranslationStep,
  synthesisStepKey,
  translationStepKey,
} from "./steps";
import {
  RESEARCH_TEST_PROVIDER,
  addUtterance,
  insertConfig,
  recordingProviders,
  setupResearchEnv,
  snapshotOf,
  type TestEnv,
} from "./test-helpers";

// Every test here uses a database and real audio bytes. The default of 5 seconds per test is too
// short when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestServiceContext;
let env: TestEnv;

beforeAll(async () => {
  t = await createTestServiceContext();
  env = await setupResearchEnv(t);
});
afterAll(async () => {
  await t.cleanup();
});

const db = () => t.testDb.db;

async function runsFor(sourceEntityId: string) {
  return db().select().from(modelRuns).where(eq(modelRuns.sourceEntityId, sourceEntityId)).orderBy(modelRuns.attemptNumber);
}

async function newBatch(dataMode: "research" | "demo" | "test" = "research") {
  return insertProcessingBatch(db(), { studyId: env.study.id, status: "running", dataMode });
}

async function translate(
  revisionId: string,
  batchId: string,
  overrides: Partial<Parameters<typeof runTranslationStep>[1]> = {},
  ctx = t.ctx,
) {
  const modelConfig = overrides.modelConfig ?? (await snapshotOf(env, env.ai.configs.translationDefault.id, "translation"));
  const conditionKey = overrides.conditionKey ?? "default";
  return runTranslationStep(ctx, {
    sourceTranscriptRevisionId: revisionId,
    modelConfig,
    conditionKey,
    processingBatchId: batchId,
    idempotencyKey: translationStepKey({
      sourceTranscriptRevisionId: revisionId,
      conditionKey,
      modelConfigId: modelConfig.modelConfigId,
      processingBatchId: batchId,
    }),
    sourceLanguage: "fi",
    targetLanguage: "en",
    ...overrides,
  });
}

describe("runAsrStep", () => {
  it("stores a complete model run and the raw output as a new current revision", async () => {
    const u = await addUtterance(env);
    const modelConfig = await snapshotOf(env, env.ai.configs.asrDefault.id, "asr");
    const { providers, calls } = recordingProviders(t.ctx.providers);
    const key = asrStepKey({ utteranceId: u.utterance.id, modelConfigId: modelConfig.modelConfigId, processingBatchId: null });

    const result = await runAsrStep({ ...t.ctx, providers }, {
      utteranceId: u.utterance.id,
      modelConfig,
      processingBatchId: null,
      idempotencyKey: key,
    });

    expect(result.created).toBe(true);
    const [run] = await runsFor(u.utterance.id);
    expect(run).toMatchObject({
      stage: "asr",
      status: "succeeded",
      provider: RESEARCH_TEST_PROVIDER,
      requestedModel: "mock-asr",
      returnedModel: "mock",
      modelConfigId: modelConfig.modelConfigId,
      promptVersionId: env.ai.prompts.asrContext.id,
      processingBatchId: null,
      sourceEntityType: "utterance",
      sourceEntityId: u.utterance.id,
      attemptNumber: 1,
      appVersion: "test",
      idempotencyKey: attemptKey(key, 1),
      errorCode: null,
      estimatedCost: null,
    });
    expect(run!.providerRequestId).toMatch(/^mock-asr-/);
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(run!.usageJson).toBeTruthy();
    expect(run!.responseMetadataJson).toBeTruthy();
    expect(run!.parametersJson).toMatchObject({ model: "mock-asr", language: "fi", prompt: "Spoken Finnish." });
    expect(run!.inputManifestJson).toMatchObject({
      utteranceId: u.utterance.id,
      mediaAssetId: u.media.id,
      mediaSha256: sha256OfBuffer(u.audio),
      sourceLanguage: "fi",
      effectiveInstruction: "Spoken Finnish.",
      modelConfigId: modelConfig.modelConfigId,
    });

    // Spec 65: the provider gets the audio, the language hint and the context prompt.
    expect(calls.asr).toHaveLength(1);
    const sent = calls.asr[0]!;
    expect(Object.keys(sent).sort()).toEqual(["audio", "fileName", "language", "mimeType", "model", "parameters", "prompt"]);
    expect(sent.audio.equals(u.audio)).toBe(true);
    expect(sent.fileName).toBe("utterance.wav");
    // The response format is resolved by the step and sent explicitly.
    expect(sent.parameters).toEqual({ response_format: "json" });
    expect(run!.parametersJson).toMatchObject({ response_format: "json" });
    expect(JSON.stringify({ ...sent, audio: undefined })).not.toContain(u.session.participantCode);

    const revision = result.revision;
    expect(revision).toMatchObject({
      revisionNumber: 1,
      isCurrent: true,
      createdByType: "model",
      sourceModelRunId: run!.id,
      verifiedAt: null,
    });
    expect(revision.text).toMatch(/^\[mock-transkriptio /);
    expect(revision.segmentsJson).toMatchObject({ segments: expect.any(Array) });
    expect(result.transcript).toMatchObject({ type: "asr", status: "not_started" });
  });

  it("adds a new revision for a second configuration and never overwrites the first", async () => {
    const u = await addUtterance(env);
    const first = await snapshotOf(env, env.ai.configs.asrDefault.id, "asr");
    const second = await insertConfig(env, {
      key: "asr_second",
      stage: "asr",
      parameters: { language: "fi", mockText: "  Toinen ASR tulos.  " },
      promptText: "",
    });
    const { providers, calls } = recordingProviders(t.ctx.providers);
    const run = (modelConfig: typeof first) =>
      runAsrStep({ ...t.ctx, providers }, {
        utteranceId: u.utterance.id,
        modelConfig,
        processingBatchId: null,
        idempotencyKey: asrStepKey({ utteranceId: u.utterance.id, modelConfigId: modelConfig.modelConfigId, processingBatchId: null }),
      });

    const a = await run(first);
    const b = await run(second);

    // An empty prompt text means that no prompt is sent.
    expect(calls.asr[1]).not.toHaveProperty("prompt");
    expect(b.modelRun.inputManifestJson).not.toHaveProperty("effectiveInstruction");
    // Exact output, including the surrounding spaces.
    expect(b.revision.text).toBe("  Toinen ASR tulos.  ");
    expect(b.revision).toMatchObject({ revisionNumber: 2, isCurrent: true });

    const rows = await db()
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.transcriptId, a.transcript.id))
      .orderBy(transcriptRevisions.revisionNumber);
    expect(rows.map((row) => [row.revisionNumber, row.isCurrent, row.text === a.revision.text])).toEqual([
      [1, false, true],
      [2, true, false],
    ]);
    expect(await db().select().from(transcripts).where(eq(transcripts.utteranceId, u.utterance.id))).toHaveLength(1);

    // A second delivery of work that succeeded returns the stored revision.
    const again = await run(first);
    expect(again.created).toBe(false);
    expect(again.revision.id).toBe(a.revision.id);
    expect(await runsFor(u.utterance.id)).toHaveLength(2);
    expect(calls.asr).toHaveLength(2);
  });

  it("leaves a failed run and the source audio untouched when the provider fails", async () => {
    const u = await addUtterance(env);
    const failing = await insertConfig(env, { key: "asr_failing", stage: "asr", parameters: { mockFail: "permanent" } });
    await expect(
      runAsrStep(t.ctx, {
        utteranceId: u.utterance.id,
        modelConfig: failing,
        processingBatchId: null,
        idempotencyKey: asrStepKey({ utteranceId: u.utterance.id, modelConfigId: failing.modelConfigId, processingBatchId: null }),
      }),
    ).rejects.toMatchObject({ code: "ASR_PROVIDER_ERROR", retryable: false });

    const [run] = await runsFor(u.utterance.id);
    expect(run).toMatchObject({ status: "failed", errorCode: "ASR_PROVIDER_ERROR", attemptNumber: 1 });
    expect(run!.errorMessage).toContain("injected permanent failure");
    expect(run!.finishedAt).not.toBeNull();
    expect(await db().select().from(transcripts).where(eq(transcripts.utteranceId, u.utterance.id))).toHaveLength(0);
    expect(await t.storage.exists(u.media.storageKey)).toBe(true);
  });

  it("never transcribes a deleted recording or a recording of another utterance", async () => {
    const u = await addUtterance(env);
    const other = await addUtterance(env);
    const modelConfig = await snapshotOf(env, env.ai.configs.asrDefault.id, "asr");
    const { providers, calls } = recordingProviders(t.ctx.providers);
    const base = { modelConfig, processingBatchId: null, idempotencyKey: `asr:test:${u.utterance.id}` };

    await expect(
      runAsrStep({ ...t.ctx, providers }, { ...base, utteranceId: u.utterance.id, mediaAssetId: other.media.id }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await db().update(mediaAssets).set({ deletedAt: new Date() }).where(eq(mediaAssets.id, u.media.id));
    await expect(runAsrStep({ ...t.ctx, providers }, { ...base, utteranceId: u.utterance.id })).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
    });
    expect(calls.asr).toHaveLength(0);
    expect(await runsFor(u.utterance.id)).toHaveLength(0);
  });
});

describe("runTranslationStep", () => {
  it("sends only the instruction and the transcript text, and stores a complete run", async () => {
    const u = await addUtterance(env, {
      session: { browserInfoJson: { userAgent: "SecretBrowser/1.0" }, flagNotes: "note-about-the-participant" },
      transcripts: { human_dialect: { text: "Mie en oikeestaan tiiä, lähetäänkö myö.", verified: true } },
    });
    const batch = await newBatch();
    const revision = u.revisions.human_dialect!;
    const { providers, calls } = recordingProviders(t.ctx.providers);

    const result = await translate(revision.id, batch.id, {}, { ...t.ctx, providers });

    expect(calls.translation).toHaveLength(1);
    const sent = calls.translation[0]!;
    expect(Object.keys(sent).sort()).toEqual([
      "instruction",
      "model",
      "parameters",
      "sourceLanguage",
      "sourceText",
      "targetLanguage",
    ]);
    expect(sent).toEqual({
      model: "mock-translation",
      instruction: env.ai.prompts.translationDefault.promptText,
      sourceText: "Mie en oikeestaan tiiä, lähetäänkö myö.",
      sourceLanguage: "fi",
      targetLanguage: "en",
      parameters: {},
    });
    const everything = JSON.stringify(sent);
    for (const hidden of [
      u.session.participantCode,
      u.session.id,
      u.utterance.id,
      u.presentation.promptSnapshot,
      "SecretBrowser",
      "note-about-the-participant",
    ]) {
      expect(everything).not.toContain(hidden);
    }

    expect(result.created).toBe(true);
    expect(result.modelRun).toMatchObject({
      stage: "translation",
      status: "succeeded",
      provider: RESEARCH_TEST_PROVIDER,
      requestedModel: "mock-translation",
      returnedModel: "mock",
      modelConfigId: env.ai.configs.translationDefault.id,
      promptVersionId: env.ai.prompts.translationDefault.id,
      processingBatchId: batch.id,
      conditionKey: "default",
      sourceEntityType: "transcript_revision",
      sourceEntityId: revision.id,
      attemptNumber: 1,
      appVersion: "test",
    });
    expect(result.modelRun.inputManifestJson).toMatchObject({
      utteranceId: u.utterance.id,
      transcriptRevisionId: revision.id,
      transcriptType: "human_dialect",
      textSha256: sha256OfBuffer(Buffer.from(revision.text, "utf8")),
      sourceLanguage: "fi",
      targetLanguage: "en",
      effectiveInstruction: env.ai.prompts.translationDefault.promptText,
      promptVersionId: env.ai.prompts.translationDefault.id,
    });
    // The transcript text itself is not copied into the run.
    expect(JSON.stringify(result.modelRun.inputManifestJson)).not.toContain("oikeestaan");
    expect(result.translation).toMatchObject({
      sourceTranscriptRevisionId: revision.id,
      conditionKey: "default",
      processingBatchId: batch.id,
      modelRunId: result.modelRun.id,
      targetLanguage: "en",
      repetitionIndex: 0,
      status: "generated",
    });
  });

  it("stores the raw model output byte for byte", async () => {
    const raw = "  Well,  I dunno…\n\n(laughs) ;  \"OK\"?  \n";
    const config = await insertConfig(env, {
      key: "translation_raw",
      stage: "translation",
      conditionKey: "raw",
      parameters: { mockText: raw },
      promptText: "Translate from {{source_language}} to {{target_language}}.",
    });
    const u = await addUtterance(env, { transcripts: { normalized: { text: "Minä en oikeastaan tiedä." } } });
    const batch = await newBatch();
    const result = await translate(u.revisions.normalized!.id, batch.id, { modelConfig: config, conditionKey: "raw" });
    expect(Buffer.from(result.translation.translatedText, "utf8").equals(Buffer.from(raw, "utf8"))).toBe(true);
    // The placeholders are filled in the instruction that is recorded.
    expect(result.modelRun.inputManifestJson.effectiveInstruction).toBe("Translate from fi to en.");
  });

  it("leaves a failed run and no translation when the provider fails, without transcript text in the error", async () => {
    const config = await insertConfig(env, {
      key: "translation_broken",
      stage: "translation",
      conditionKey: "broken",
      parameters: { mockFail: "permanent" },
      promptText: "Translate.",
    });
    const u = await addUtterance(env, { transcripts: { human_dialect: { text: "Salainen lause tässä." } } });
    const batch = await newBatch();
    await expect(
      translate(u.revisions.human_dialect!.id, batch.id, { modelConfig: config, conditionKey: "broken" }),
    ).rejects.toMatchObject({ code: "TRANSLATION_PROVIDER_ERROR", retryable: false });

    const runs = await runsFor(u.revisions.human_dialect!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", errorCode: "TRANSLATION_PROVIDER_ERROR" });
    expect(runs[0]!.errorMessage).not.toContain("Salainen");
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).toHaveLength(0);
    // Upstream data is untouched (spec 144).
    const [revision] = await db()
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.id, u.revisions.human_dialect!.id));
    expect(revision).toMatchObject({ isCurrent: true, text: "Salainen lause tässä." });
  });

  it("makes each attempt its own run and returns the stored output for work that succeeded", async () => {
    const config = await insertConfig(env, {
      key: "translation_flaky_step",
      stage: "translation",
      conditionKey: "flaky",
      parameters: { mockFail: "retryable", mockFailTimes: 1 },
      promptText: "Translate once more.",
    });
    const u = await addUtterance(env, { transcripts: { human_dialect: { text: "Yritetään uudestaan." } } });
    const batch = await newBatch();
    const call = () => translate(u.revisions.human_dialect!.id, batch.id, { modelConfig: config, conditionKey: "flaky" });

    await expect(call()).rejects.toMatchObject({ code: "TRANSLATION_PROVIDER_ERROR", retryable: true });
    const second = await call();
    const third = await call();

    expect(second.created).toBe(true);
    expect(third.created).toBe(false);
    expect(third.translation.id).toBe(second.translation.id);
    const runs = await runsFor(u.revisions.human_dialect!.id);
    expect(runs.map((run) => [run.attemptNumber, run.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    expect(runs[1]!.idempotencyKey).toBe(`${runs[0]!.idempotencyKey.slice(0, -2)}#2`);
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).toHaveLength(1);
  });

  it("closes an interrupted attempt before a new one, so a crash cannot give two outputs", async () => {
    const u = await addUtterance(env, { transcripts: { human_dialect: { text: "Kone kaatui kesken." } } });
    const batch = await newBatch();
    const revisionId = u.revisions.human_dialect!.id;
    const modelConfig = await snapshotOf(env, env.ai.configs.translationDefault.id, "translation");
    const key = translationStepKey({
      sourceTranscriptRevisionId: revisionId,
      conditionKey: "default",
      modelConfigId: modelConfig.modelConfigId,
      processingBatchId: batch.id,
    });
    // The worker stopped after inserting the run and before storing the output.
    const stale = await insertModelRun(db(), {
      stage: "translation",
      sourceEntityType: "transcript_revision",
      sourceEntityId: revisionId,
      processingBatchId: batch.id,
      idempotencyKey: attemptKey(key, 1),
      attemptNumber: 1,
    });

    const result = await translate(revisionId, batch.id);

    expect(result.modelRun.attemptNumber).toBe(2);
    const runs = await runsFor(revisionId);
    expect(runs.map((run) => [run.id === stale.id, run.status, run.errorCode])).toEqual([
      [true, "failed", INTERRUPTED_RUN_ERROR_CODE],
      [false, "succeeded", null],
    ]);
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).toHaveLength(1);
  });

  it("fails with CONFIGURATION_MISSING when the configuration has no prompt", async () => {
    const config = await insertConfig(env, { key: "translation_no_prompt", stage: "translation", conditionKey: "none" });
    const u = await addUtterance(env, { transcripts: { human_dialect: { text: "Ei ohjetta." } } });
    const batch = await newBatch();
    const { providers, calls } = recordingProviders(t.ctx.providers);
    await expect(
      translate(u.revisions.human_dialect!.id, batch.id, { modelConfig: config, conditionKey: "none" }, { ...t.ctx, providers }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_MISSING" });
    expect(calls.translation).toHaveLength(0);
  });

  it("refuses a revision of another utterance and a batch of another data mode before any model call", async () => {
    const u = await addUtterance(env, { transcripts: { human_dialect: { text: "Oma lause." } } });
    const other = await addUtterance(env, { transcripts: { human_dialect: { text: "Toisen lause." } } });
    const testUtterance = await addUtterance(env, { mode: "test", transcripts: { human_dialect: { text: "Testilause." } } });
    const batch = await newBatch();
    const { providers, calls } = recordingProviders(t.ctx.providers);
    const ctx = { ...t.ctx, providers };

    await expect(
      translate(other.revisions.human_dialect!.id, batch.id, { expectedUtteranceId: u.utterance.id }, ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(translate(testUtterance.revisions.human_dialect!.id, batch.id, {}, ctx)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(calls.translation).toHaveLength(0);
    expect(await db().select().from(modelRuns).where(eq(modelRuns.processingBatchId, batch.id))).toHaveLength(0);

    const testBatch = await newBatch("test");
    const ok = await translate(testUtterance.revisions.human_dialect!.id, testBatch.id, {}, ctx);
    expect(ok.created).toBe(true);
  });
});

describe("runSynthesisStep", () => {
  async function translated(text: string) {
    const u = await addUtterance(env, { transcripts: { human_dialect: { text } } });
    const batch = await newBatch();
    const { translation } = await translate(u.revisions.human_dialect!.id, batch.id);
    return { u, batch, translation };
  }

  async function synthesize(translationId: string, batchId: string, modelConfig?: Awaited<ReturnType<typeof snapshotOf>>, ctx = t.ctx) {
    const config = modelConfig ?? (await snapshotOf(env, env.ai.configs.ttsBaseline.id, "tts"));
    return runSynthesisStep(ctx, {
      translationId,
      modelConfig: config,
      conditionKey: "baseline",
      processingBatchId: batchId,
      idempotencyKey: synthesisStepKey({
        translationId,
        conditionKey: "baseline",
        modelConfigId: config.modelConfigId,
        processingBatchId: batchId,
      }),
    });
  }

  it("synthesizes the exact stored text and stores the audio, the asset and a complete run", async () => {
    const { u, batch, translation } = await translated("Puhutaan tämä ääneen.");
    const { providers, calls } = recordingProviders(t.ctx.providers);

    const result = await synthesize(translation.id, batch.id, undefined, { ...t.ctx, providers });

    // Spec 65: translated text, voice and synthesis instruction, nothing else.
    expect(calls.tts).toHaveLength(1);
    expect(calls.tts[0]).toEqual({
      model: "mock-tts",
      text: translation.translatedText,
      voice: "mock-voice",
      instructions: "Speak the text naturally.",
      outputFormat: "wav",
      parameters: {},
    });
    expect(JSON.stringify(calls.tts[0])).not.toContain(u.session.participantCode);

    expect(result.synthesis).toMatchObject({
      translationId: translation.id,
      sourceText: translation.translatedText,
      conditionKey: "baseline",
      processingBatchId: batch.id,
      modelRunId: result.modelRun.id,
      mediaAssetId: result.mediaAsset.id,
      voiceKey: "mock-voice",
    });
    const stored = t.storage.keys().find((key) => key === result.mediaAsset.storageKey);
    expect(stored).toBe(`studies/${env.study.slug}/generated/syntheses/${result.synthesis.id}/${result.mediaAsset.id}.wav`);
    const audio = calls.tts.length ? Buffer.concat(await t.storage.get(stored!).then((s) => s.toArray())) : Buffer.alloc(0);
    expect(result.mediaAsset).toMatchObject({
      kind: "tts_audio",
      entityType: "synthesis",
      entityId: result.synthesis.id,
      studyId: env.study.id,
      mimeType: "audio/wav",
      container: "wav",
      codec: "pcm_s16le",
      sampleRateHz: 16000,
      channels: 1,
      bitDepth: 16,
      sizeBytes: audio.length,
      sha256: sha256OfBuffer(audio),
    });
    expect(result.mediaAsset.durationMs).toBeGreaterThan(0);
    expect(result.modelRun).toMatchObject({
      stage: "tts",
      status: "succeeded",
      requestedModel: "mock-tts",
      modelConfigId: env.ai.configs.ttsBaseline.id,
      promptVersionId: env.ai.prompts.ttsBaseline.id,
      processingBatchId: batch.id,
      conditionKey: "baseline",
      sourceEntityType: "translation",
      sourceEntityId: translation.id,
    });
    expect(result.modelRun.parametersJson).toMatchObject({ voice: "mock-voice", response_format: "wav" });
    expect(result.modelRun.inputManifestJson).toMatchObject({
      translationId: translation.id,
      textSha256: sha256OfBuffer(Buffer.from(translation.translatedText, "utf8")),
      effectiveInstruction: "Speak the text naturally.",
      voice: "mock-voice",
    });

    // A second delivery creates nothing.
    const again = await synthesize(translation.id, batch.id, undefined, { ...t.ctx, providers });
    expect(again.created).toBe(false);
    expect(again.synthesis.id).toBe(result.synthesis.id);
    expect(calls.tts).toHaveLength(1);
    expect(await db().select().from(syntheses).where(eq(syntheses.translationId, translation.id))).toHaveLength(1);
  });

  it("keeps the translation and stores no audio when TTS fails", async () => {
    const { batch, translation } = await translated("Tämä synteesi epäonnistuu.");
    const failing = await insertConfig(env, {
      key: "tts_failing",
      stage: "tts",
      conditionKey: "baseline",
      parameters: { voice: "mock-voice", mockFail: "permanent" },
    });
    const keysBefore = t.storage.keys().length;
    await expect(synthesize(translation.id, batch.id, failing)).rejects.toMatchObject({ code: "TTS_PROVIDER_ERROR" });

    const runs = await runsFor(translation.id);
    expect(runs.map((run) => [run.stage, run.status])).toEqual([["tts", "failed"]]);
    expect(await db().select().from(syntheses).where(eq(syntheses.translationId, translation.id))).toHaveLength(0);
    expect(t.storage.keys()).toHaveLength(keysBefore);
    const [kept] = await db().select().from(translations).where(eq(translations.id, translation.id));
    expect(kept!.translatedText).toBe(translation.translatedText);
  });

  it("fails with CONFIGURATION_MISSING when the configuration has no voice", async () => {
    const { batch, translation } = await translated("Ei ääntä valittu.");
    const noVoice = await insertConfig(env, { key: "tts_no_voice", stage: "tts", conditionKey: "baseline" });
    await expect(synthesize(translation.id, batch.id, noVoice)).rejects.toMatchObject({ code: "CONFIGURATION_MISSING" });
    expect(await runsFor(translation.id)).toHaveLength(0);
  });
});

describe("describeSynthesizedAudio", () => {
  it("computes the duration from the bytes that are present, not from the declared size", async () => {
    const wav = generateSineWav({ durationMs: 500, sampleRateHz: 24000, frequencyHz: 300 });
    const streamed = Buffer.from(wav);
    // A streamed WAV declares the largest possible sizes.
    streamed.writeUInt32LE(0xffffffff, 4);
    streamed.writeUInt32LE(0xffffffff, streamed.indexOf("data") + 4);
    expect(await describeSynthesizedAudio(streamed, "wav")).toMatchObject({
      container: "wav",
      codec: "pcm_s16le",
      sampleRateHz: 24000,
      channels: 1,
      bitDepth: 16,
      durationMs: 500,
      source: "wav_header",
    });
  });

  it("leaves the fields null for raw samples without a header", async () => {
    expect(await describeSynthesizedAudio(Buffer.alloc(3200), "pcm")).toMatchObject({
      container: null,
      sampleRateHz: null,
      durationMs: null,
      source: "unknown",
    });
  });
});
