// What a failed run keeps (spec 146), which provider may process research data,
// and the request values the steps resolve themselves.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { AiProviderError, type ProviderRegistry } from "@dialect/ai";
import { modelConfigs, modelRuns, syntheses, translations } from "@dialect/db";
import { insertProcessingBatch } from "@dialect/db/testing-builders";
import { toModelRunSummary } from "../corpus/lineage";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { getUtteranceLineage } from "./lineage";
import {
  asrStepKey,
  failedRunRecord,
  runAsrStep,
  runSynthesisStep,
  runTranslationStep,
  synthesisStepKey,
  translationStepKey,
} from "./steps";
import { addUtterance, insertConfig, recordingProviders, setupResearchEnv, snapshotOf, type TestEnv } from "./test-helpers";

// Every test here uses a database and real audio bytes. The default of 5
// seconds is too short when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

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
const runsFor = (sourceEntityId: string) =>
  db().select().from(modelRuns).where(eq(modelRuns.sourceEntityId, sourceEntityId)).orderBy(modelRuns.attemptNumber);
const newBatch = (dataMode: "research" | "demo" | "test" = "research") =>
  insertProcessingBatch(db(), { studyId: env.study.id, status: "running", dataMode });

async function translate(revisionId: string, batchId: string, ctx = t.ctx, configId = env.ai.configs.translationDefault.id) {
  const modelConfig = await snapshotOf(env, configId, "translation");
  const conditionKey = modelConfig.conditionKey ?? modelConfig.key;
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
  });
}

// A registry whose translator answers like a provider that refused the request.
function refusingProviders(inner: ProviderRegistry): ProviderRegistry {
  return {
    ...inner,
    translator: () => ({
      translate: async () => {
        throw new AiProviderError({
          stage: "translation",
          provider: "openai",
          message: "The translation was refused by the model: I cannot help with that.",
          retryable: false,
          providerStatus: 200,
          providerRequestId: "req_refused_1",
          providerErrorCode: "refusal",
          details: {
            responseId: "resp_refused_1",
            refusal: "I cannot help with that.",
            partialText: "  I do not ",
            rawMetadata: {
              endpoint: "responses",
              headers: { "x-request-id": "req_refused_1", authorization: "Bearer sk-test-1234567890abcdef" },
              response: { id: "resp_refused_1", status: "completed", model: "model-x-2026" },
              note: "key sk-test-1234567890abcdef was used",
            },
          },
        });
      },
    }),
  };
}

describe("a failed run keeps the provider response (spec 146)", () => {
  it("stores a refusal with the partial text, the response metadata, the request id and the parameters, without secrets", async () => {
    const u = await addUtterance(env, { transcripts: { human_dialect: { text: "Tämä lause torjutaan." } } });
    const batch = await newBatch();
    const revisionId = u.revisions.human_dialect!.id;

    await expect(translate(revisionId, batch.id, { ...t.ctx, providers: refusingProviders(t.ctx.providers) })).rejects.toMatchObject({
      code: "TRANSLATION_PROVIDER_ERROR",
    });

    const [run] = await runsFor(revisionId);
    expect(run).toMatchObject({
      status: "failed",
      errorCode: "TRANSLATION_PROVIDER_ERROR",
      providerRequestId: "req_refused_1",
      // The request as the step planned it.
      parametersJson: { model: "mock-translation" },
    });
    expect(run!.responseMetadataJson).toMatchObject({
      endpoint: "responses",
      response: { id: "resp_refused_1", status: "completed", model: "model-x-2026" },
      failure: {
        providerStatus: 200,
        providerErrorCode: "refusal",
        retryable: false,
        responseId: "resp_refused_1",
        refusal: "I cannot help with that.",
        // Exactly as returned, including the spaces.
        partialText: "  I do not ",
      },
    });
    const stored = JSON.stringify(run!.responseMetadataJson);
    expect(stored).not.toContain("sk-test");
    expect(stored).not.toContain("authorization");
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).toHaveLength(0);

    // The lineage read model and the Session Detail summary show it.
    const lineage = await getUtteranceLineage(t.adminCtx, u.utterance.id);
    const failed = lineage.failedRuns.find((candidate) => candidate.id === run!.id);
    expect(failed?.responseMetadata).toMatchObject({ failure: { refusal: "I cannot help with that." } });
    expect(toModelRunSummary(run!, { configs: new Map(), prompts: new Map() }).failure).toEqual({
      providerStatus: 200,
      providerErrorCode: "refusal",
      retryable: false,
      responseId: "resp_refused_1",
      responseStatus: "completed",
      refusal: "I cannot help with that.",
      outputText: "  I do not ",
    });
  });

  it("stores an empty translation as a failed run with the raw answer and the parameters the adapter sent", async () => {
    const config = await insertConfig(env, {
      key: "translation_empty",
      stage: "translation",
      conditionKey: "empty",
      parameters: { mockText: "  " },
      promptText: "Translate.",
    });
    const u = await addUtterance(env, { transcripts: { human_dialect: { text: "Tyhjä vastaus." } } });
    const batch = await newBatch();
    const revisionId = u.revisions.human_dialect!.id;

    await expect(translate(revisionId, batch.id, t.ctx, config.modelConfigId)).rejects.toMatchObject({
      code: "TRANSLATION_PROVIDER_ERROR",
    });

    const [run] = await runsFor(revisionId);
    expect(run).toMatchObject({ status: "failed", returnedModel: "mock" });
    expect(run!.providerRequestId).toMatch(/^mock-translation-/);
    expect(run!.parametersJson).toMatchObject({ model: "mock-translation", mockText: "  " });
    expect(run!.responseMetadataJson).toMatchObject({ failure: { providerErrorCode: "empty_output", rawText: "  " } });
    expect(toModelRunSummary(run!, { configs: new Map(), prompts: new Map() }).failure).toMatchObject({
      providerErrorCode: "empty_output",
      outputText: "  ",
    });
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).toHaveLength(0);
  });

  it("keeps status, error code and request id of a provider error without a response body", async () => {
    const u = await addUtterance(env);
    const failing = await insertConfig(env, { key: "asr_failing_detail", stage: "asr", parameters: { mockFail: "retryable" } });
    await expect(
      runAsrStep(t.ctx, {
        utteranceId: u.utterance.id,
        modelConfig: failing,
        processingBatchId: null,
        idempotencyKey: asrStepKey({ utteranceId: u.utterance.id, modelConfigId: failing.modelConfigId, processingBatchId: null }),
      }),
    ).rejects.toMatchObject({ code: "ASR_PROVIDER_ERROR" });
    const [run] = await runsFor(u.utterance.id);
    expect(run!.providerRequestId).toMatch(/^mock-asr-/);
    expect(run!.responseMetadataJson).toMatchObject({
      failure: { providerStatus: 503, providerErrorCode: "mock_retryable_failure", retryable: true },
    });
    // The request that was planned, with the resolved response format.
    expect(run!.parametersJson).toMatchObject({ model: "mock-asr", response_format: "json", mockFail: "retryable" });
  });

  it("drops credential keys and key material, and returns nothing for an error without details", () => {
    const record = failedRunRecord(
      new AiProviderError({
        stage: "tts",
        provider: "openai",
        message: "failed",
        retryable: false,
        details: { apiKey: "sk-abcdefgh12345678", note: "sent with Bearer abcdefgh12345678", parametersSent: { voice: "v", api_key: "x" } },
      }),
    );
    expect(JSON.stringify(record)).not.toMatch(/sk-abcdefgh|abcdefgh12345678|apiKey|api_key/);
    expect(record.parametersSent).toEqual({ voice: "v" });
  });
});

describe("the mock provider never processes research data", () => {
  it("refuses a mock configuration for a research utterance in every step, before any run, and accepts it for test data", async () => {
    const mockAsr = await insertConfig(env, { key: "asr_mock_provider", stage: "asr", provider: "mock" });
    const mockTranslation = await insertConfig(env, {
      key: "translation_mock_provider",
      stage: "translation",
      conditionKey: "mock_provider",
      provider: "mock",
      promptText: "Translate.",
    });
    const research = await addUtterance(env, { transcripts: { human_dialect: { text: "Tutkimuslause." } } });
    const test = await addUtterance(env, { mode: "test", transcripts: { human_dialect: { text: "Testilause." } } });
    const { providers, calls } = recordingProviders(t.ctx.providers);
    const ctx = { ...t.ctx, providers };
    const asr = (utteranceId: string) =>
      runAsrStep(ctx, {
        utteranceId,
        modelConfig: mockAsr,
        processingBatchId: null,
        idempotencyKey: asrStepKey({ utteranceId, modelConfigId: mockAsr.modelConfigId, processingBatchId: null }),
      });

    await expect(asr(research.utterance.id)).rejects.toMatchObject({
      code: "CONFIGURATION_MISSING",
      message: expect.stringContaining("uses the mock provider"),
    });
    const researchBatch = await newBatch();
    await expect(
      translate(research.revisions.human_dialect!.id, researchBatch.id, ctx, mockTranslation.modelConfigId),
    ).rejects.toMatchObject({ code: "CONFIGURATION_MISSING" });
    expect(calls.asr).toHaveLength(0);
    expect(calls.translation).toHaveLength(0);
    expect(await runsFor(research.utterance.id)).toHaveLength(0);
    expect(await runsFor(research.revisions.human_dialect!.id)).toHaveLength(0);

    expect((await asr(test.utterance.id)).created).toBe(true);
    const testBatch = await newBatch("test");
    const translated = await translate(test.revisions.human_dialect!.id, testBatch.id, ctx, mockTranslation.modelConfigId);
    expect(translated.modelRun).toMatchObject({ provider: "mock", status: "succeeded" });
  });
});

describe("request values resolved by the step", () => {
  async function translated(text: string) {
    const u = await addUtterance(env, { transcripts: { human_dialect: { text } } });
    const batch = await newBatch();
    const { translation } = await translate(u.revisions.human_dialect!.id, batch.id);
    return { batch, translation };
  }

  async function synthesize(translationId: string, batchId: string, modelConfigId: string, ctx = t.ctx) {
    const modelConfig = await snapshotOf(env, modelConfigId, "tts");
    return runSynthesisStep(ctx, {
      translationId,
      modelConfig,
      conditionKey: "baseline",
      processingBatchId: batchId,
      idempotencyKey: synthesisStepKey({
        translationId,
        conditionKey: "baseline",
        modelConfigId: modelConfig.modelConfigId,
        processingBatchId: batchId,
      }),
    });
  }

  it("sends and records the configured ASR response format, and json when the configuration names none", async () => {
    const verbose = await insertConfig(env, {
      key: "asr_verbose",
      stage: "asr",
      parameters: { language: "fi", response_format: "verbose_json" },
    });
    const u = await addUtterance(env);
    const { providers, calls } = recordingProviders(t.ctx.providers);
    const result = await runAsrStep({ ...t.ctx, providers }, {
      utteranceId: u.utterance.id,
      modelConfig: verbose,
      processingBatchId: null,
      idempotencyKey: asrStepKey({ utteranceId: u.utterance.id, modelConfigId: verbose.modelConfigId, processingBatchId: null }),
    });
    expect(calls.asr[0]!.parameters).toEqual({ response_format: "verbose_json" });
    expect(result.modelRun.parametersJson).toMatchObject({ response_format: "verbose_json" });
    // Segments are stored exactly as the adapter returned them.
    const sent = await t.ctx.providers.transcriber(verbose.provider).transcribe(calls.asr[0]!);
    expect(result.revision.segmentsJson).toEqual({ segments: sent.segments });
  });

  it("sends and records the TTS output format when the configuration names none", async () => {
    const noFormat = await insertConfig(env, {
      key: "tts_no_format",
      stage: "tts",
      conditionKey: "baseline",
      parameters: { voice: "mock-voice" },
      promptText: "Speak naturally.",
    });
    const { batch, translation } = await translated("Muoto puuttuu asetuksista.");
    const { providers, calls } = recordingProviders(t.ctx.providers);
    const result = await synthesize(translation.id, batch.id, noFormat.modelConfigId, { ...t.ctx, providers });
    expect(calls.tts[0]).toMatchObject({ outputFormat: "wav" });
    expect(result.modelRun.parametersJson).toMatchObject({ voice: "mock-voice", response_format: "wav" });
  });

  it("refuses a TTS configuration with a linked prompt and an instructions parameter, before any model call", async () => {
    const both = await insertConfig(env, {
      key: "tts_two_instructions",
      stage: "tts",
      conditionKey: "baseline",
      parameters: { voice: "mock-voice", response_format: "wav", instructions: "Speak slowly." },
      promptText: "Speak naturally.",
    });
    const parameterOnly = await insertConfig(env, {
      key: "tts_parameter_instruction",
      stage: "tts",
      conditionKey: "baseline",
      parameters: { voice: "mock-voice", response_format: "wav", instructions: "Speak slowly." },
    });
    const { batch, translation } = await translated("Kaksi ohjetta.");
    const { providers, calls } = recordingProviders(t.ctx.providers);
    const ctx = { ...t.ctx, providers };

    await expect(synthesize(translation.id, batch.id, both.modelConfigId, ctx)).rejects.toMatchObject({
      code: "CONFIGURATION_MISSING",
      message: expect.stringContaining('a linked prompt version and an "instructions" parameter'),
    });
    expect(calls.tts).toHaveLength(0);
    expect(await runsFor(translation.id)).toHaveLength(0);
    expect(await db().select().from(syntheses).where(eq(syntheses.translationId, translation.id))).toHaveLength(0);

    // Without a prompt version the parameter is the instruction.
    const ok = await synthesize(translation.id, batch.id, parameterOnly.modelConfigId, ctx);
    expect(calls.tts[0]).toMatchObject({ instructions: "Speak slowly." });
    expect(ok.modelRun.parametersJson).toMatchObject({ instructions: "Speak slowly." });
    expect(await db().select().from(modelConfigs).where(eq(modelConfigs.id, both.modelConfigId))).toHaveLength(1);
  });
});
