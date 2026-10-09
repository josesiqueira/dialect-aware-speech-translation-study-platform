import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAuditLog, modelConfigs, modelRuns } from "@dialect/db";
import { insertActiveAiConfigs, insertModelRun, insertStudy } from "@dialect/db/testing-builders";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import type { ServiceContext } from "../context";
import {
  activateModelConfig,
  cloneModelConfig,
  createModelConfigDraft,
  deleteModelConfigDraft,
  diffModelConfigs,
  getActiveConfigsForPipeline,
  getActiveModelConfig,
  getModelConfig,
  listModelConfigs,
  retireModelConfig,
  updateModelConfigDraft,
} from "./configs";
import { activatePromptVersion, clonePromptVersion, createPromptDraft, retirePromptVersion } from "./prompts";
import { listProviderStatus } from "./providers";

let t: TestServiceContext;
let ctx: ServiceContext;

beforeAll(async () => {
  t = await createTestServiceContext();
  ctx = t.adminCtx;
});

afterAll(async () => {
  await t.cleanup();
});

async function seeded() {
  const study = await insertStudy(ctx.db);
  const ai = await insertActiveAiConfigs(ctx.db, { studyId: study.id });
  return { studyId: study.id, ...ai };
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await ctx.db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.entityId, entityId))
    .orderBy(adminAuditLog.createdAt);
  return rows.map((row) => row.action);
}

const translationDraft = (studyId: string, promptVersionId: string | null, overrides: Record<string, unknown> = {}) => ({
  studyId,
  key: "translation_default",
  stage: "translation" as const,
  conditionKey: "default",
  name: "Translation, default condition",
  provider: "openai",
  modelId: "researcher-entered-model",
  parameters: {},
  promptVersionId,
  ...overrides,
});

describe("model config drafts", () => {
  it("creates a draft with the next version number, stores only the given parameters and writes an audit row", async () => {
    const { studyId, prompts } = await seeded();
    const draft = await createModelConfigDraft(
      ctx,
      translationDraft(studyId, prompts.translationDefault.id, { parameters: { max_output_tokens: 500 } }),
    );
    expect(draft).toMatchObject({
      versionNumber: 2,
      status: "draft",
      provider: "openai",
      modelId: "researcher-entered-model",
      // Nothing was added: no temperature, no other default.
      parametersJson: { max_output_tokens: 500 },
      promptVersionId: prompts.translationDefault.id,
      createdByLabel: "admin",
    });
    expect(await auditActions(draft.id)).toEqual(["model_config.create"]);
  });

  it("allows only one draft per key", async () => {
    const { studyId, prompts } = await seeded();
    const draft = await createModelConfigDraft(ctx, translationDraft(studyId, prompts.translationDefault.id));
    await expect(createModelConfigDraft(ctx, translationDraft(studyId, prompts.translationDefault.id))).rejects.toMatchObject({
      code: "CONFLICT",
      details: { existingDraftId: draft.id },
    });
    await expect(cloneModelConfig(ctx, draft.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an unknown provider", async () => {
    const { studyId, prompts } = await seeded();
    await expect(
      createModelConfigDraft(ctx, translationDraft(studyId, prompts.translationDefault.id, { provider: "acme" })),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining('Unknown AI provider "acme"'),
      details: { availableProviders: ["openai", "mock"] },
    });
  });

  it("rejects parameters outside the openai allow-list of the stage, and wrong values", async () => {
    const { studyId, prompts } = await seeded();
    await expect(
      createModelConfigDraft(ctx, translationDraft(studyId, prompts.translationDefault.id, { parameters: { top_k: 5 } })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining('"top_k"') });
    await expect(
      createModelConfigDraft(ctx, translationDraft(studyId, prompts.translationDefault.id, { parameters: { temperature: 9 } })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("temperature") });
    // "voice" is a TTS key, not a translation one.
    await expect(
      createModelConfigDraft(ctx, translationDraft(studyId, prompts.translationDefault.id, { parameters: { voice: "x" } })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const draft = await createModelConfigDraft(ctx, translationDraft(studyId, prompts.translationDefault.id));
    await expect(updateModelConfigDraft(ctx, draft.id, { parameters: { user: "p-17" } })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect((await getModelConfig(ctx, draft.id)).parametersJson).toEqual({});
  });

  it("accepts the config level keys: language for ASR, voice, response_format and instructions for TTS", async () => {
    const { studyId, prompts } = await seeded();
    const asr = await createModelConfigDraft(ctx, {
      studyId,
      key: "asr_default",
      stage: "asr",
      provider: "openai",
      modelId: "researcher-entered-asr-model",
      parameters: { language: "fi", response_format: "verbose_json", timestamp_granularities: ["segment"] },
      promptVersionId: prompts.asrContext.id,
    });
    expect(asr.parametersJson).toEqual({
      language: "fi",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });
    await expect(
      updateModelConfigDraft(ctx, asr.id, { parameters: { language: "fi", timestamp_granularities: ["word"] } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("verbose_json") });
    await expect(updateModelConfigDraft(ctx, asr.id, { parameters: { voice: "x" } })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    const tts = await createModelConfigDraft(ctx, {
      studyId,
      key: "tts_baseline",
      stage: "tts",
      provider: "openai",
      modelId: "researcher-entered-tts-model",
      parameters: { voice: "voice-a", response_format: "wav", instructions: "Speak plainly.", speed: 1 },
      promptVersionId: null,
    });
    expect(tts.parametersJson).toEqual({ voice: "voice-a", response_format: "wav", instructions: "Speak plainly.", speed: 1 });
    await expect(
      updateModelConfigDraft(ctx, tts.id, { parameters: { voice: "voice-a", response_format: "ogg" } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The instruction comes from one place: the parameter or the linked prompt, not both.
    await expect(updateModelConfigDraft(ctx, tts.id, { promptVersionId: prompts.ttsBaseline.id })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("instructions"),
    });
  });

  it("accepts provider specific parameters of another provider but still checks the config level keys", async () => {
    const { studyId, prompts } = await seeded();
    const draft = await createModelConfigDraft(ctx, {
      studyId,
      key: "tts_baseline",
      stage: "tts",
      provider: "mock",
      modelId: "mock-tts",
      parameters: { voice: "mock-voice", mockFail: "retryable" },
      promptVersionId: prompts.ttsBaseline.id,
    });
    expect(draft.parametersJson).toEqual({ voice: "mock-voice", mockFail: "retryable" });
    await expect(updateModelConfigDraft(ctx, draft.id, { parameters: { voice: 7 } })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects a prompt of another stage or another study", async () => {
    const { studyId, prompts } = await seeded();
    const other = await seeded();
    await expect(createModelConfigDraft(ctx, translationDraft(studyId, prompts.ttsBaseline.id))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("tts stage"),
    });
    await expect(
      createModelConfigDraft(ctx, translationDraft(studyId, other.prompts.translationDefault.id)),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createModelConfigDraft(ctx, translationDraft(studyId, randomUUID()))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("updates a draft, refuses to change an active config, and deletes only drafts", async () => {
    const { studyId, prompts, configs } = await seeded();
    const draft = await createModelConfigDraft(ctx, translationDraft(studyId, prompts.translationDefault.id));
    const updated = await updateModelConfigDraft(ctx, draft.id, { modelId: "another-model", parameters: { store: false } });
    expect(updated).toMatchObject({ modelId: "another-model", parametersJson: { store: false }, status: "draft" });
    expect(await auditActions(draft.id)).toEqual(["model_config.create", "model_config.update_draft"]);

    await expect(updateModelConfigDraft(ctx, configs.translationDefault.id, { modelId: "changed" })).rejects.toMatchObject({
      code: "IMMUTABLE_RECORD",
    });
    await expect(deleteModelConfigDraft(ctx, configs.translationDefault.id)).rejects.toMatchObject({
      code: "IMMUTABLE_RECORD",
    });
    expect((await getModelConfig(ctx, configs.translationDefault.id)).modelId).toBe(configs.translationDefault.modelId);

    expect(await deleteModelConfigDraft(ctx, draft.id)).toEqual({ deleted: true, id: draft.id });
    await expect(getModelConfig(ctx, draft.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await auditActions(draft.id)).toEqual([
      "model_config.create",
      "model_config.update_draft",
      "model_config.delete_draft",
    ]);
  });
});

describe("model config activation", () => {
  it("activates a draft and retires the previous active config in the same step", async () => {
    const { studyId, configs } = await seeded();
    const run = await insertModelRun(ctx.db, {
      sourceEntityType: "transcript_revision",
      sourceEntityId: randomUUID(),
      modelConfigId: configs.translationDefault.id,
      promptVersionId: configs.translationDefault.promptVersionId,
      status: "succeeded",
      finishedAt: new Date(),
    });
    const draft = await cloneModelConfig(ctx, configs.translationDefault.id);
    await updateModelConfigDraft(ctx, draft.id, { modelId: "mock-translation-2" });
    const result = await activateModelConfig(ctx, draft.id);

    expect(result.config).toMatchObject({ id: draft.id, status: "active", versionNumber: 2 });
    expect(result.retired).toMatchObject({ id: configs.translationDefault.id, status: "retired" });
    expect((await getActiveModelConfig(ctx, studyId, "translation_default"))?.id).toBe(draft.id);
    expect(await auditActions(draft.id)).toEqual([
      "model_config.create",
      "model_config.update_draft",
      "model_config.activate",
    ]);
    expect(await auditActions(configs.translationDefault.id)).toEqual(["model_config.retire"]);

    // The old run still names the old config.
    const [after] = await ctx.db.select().from(modelRuns).where(eq(modelRuns.id, run.id));
    expect(after).toEqual(run);
    await expect(activateModelConfig(ctx, draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(activateModelConfig(ctx, configs.translationDefault.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("keeps one active config per key when two drafts are activated at the same time", async () => {
    const { studyId, configs } = await seeded();
    const first = await cloneModelConfig(ctx, configs.ttsBaseline.id);
    const [second] = await ctx.db
      .insert(modelConfigs)
      .values({
        studyId,
        key: "tts_baseline",
        stage: "tts",
        versionNumber: 3,
        provider: "mock",
        modelId: "mock-tts",
        parametersJson: { voice: "other-voice" },
      })
      .returning();
    const results = await Promise.allSettled([activateModelConfig(ctx, first.id), activateModelConfig(ctx, second!.id)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const rows = await listModelConfigs(ctx, { studyId, key: "tts_baseline" });
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "retired")).toHaveLength(2);
  });

  it("requires the linked prompt to be active or retired, not a draft", async () => {
    const { studyId, prompts, configs } = await seeded();
    const promptDraft = await clonePromptVersion(ctx, prompts.translationDefault.id);
    const draft = await cloneModelConfig(ctx, configs.translationDefault.id);
    await updateModelConfigDraft(ctx, draft.id, { promptVersionId: promptDraft.id });

    await expect(activateModelConfig(ctx, draft.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("still a draft"),
    });
    expect((await getActiveModelConfig(ctx, studyId, "translation_default"))?.id).toBe(configs.translationDefault.id);

    await activatePromptVersion(ctx, promptDraft.id);
    const result = await activateModelConfig(ctx, draft.id);
    expect(result.config).toMatchObject({ status: "active", promptVersionId: promptDraft.id });
  });

  it("requires a prompt for translation and a voice for TTS", async () => {
    const { configs } = await seeded();
    const translation = await cloneModelConfig(ctx, configs.translationPreserve.id);
    await updateModelConfigDraft(ctx, translation.id, { promptVersionId: null });
    await expect(activateModelConfig(ctx, translation.id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("linked prompt"),
    });

    const tts = await cloneModelConfig(ctx, configs.ttsBaseline.id);
    await updateModelConfigDraft(ctx, tts.id, { parameters: { response_format: "wav" } });
    await expect(activateModelConfig(ctx, tts.id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("voice"),
    });
    await updateModelConfigDraft(ctx, tts.id, { parameters: { voice: "mock-voice", response_format: "wav" } });
    expect((await activateModelConfig(ctx, tts.id)).config.status).toBe("active");
  });

  it("retires an active config and writes an audit row", async () => {
    const { studyId, configs } = await seeded();
    const retired = await retireModelConfig(ctx, configs.asrDefault.id);
    expect(retired.status).toBe("retired");
    expect(await getActiveModelConfig(ctx, studyId, "asr_default")).toBeNull();
    expect(await auditActions(configs.asrDefault.id)).toEqual(["model_config.retire"]);
    await expect(retireModelConfig(ctx, configs.asrDefault.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    // With the config retired, its prompt can be retired too.
    expect((await retirePromptVersion(ctx, configs.asrDefault.promptVersionId!)).status).toBe("retired");
  });
});

describe("prompt activation and active configs", () => {
  it("shows that an active config uses an older prompt version, and adopts the active one only through a new config version", async () => {
    const { studyId, prompts, configs } = await seeded();
    const promptDraft = await clonePromptVersion(ctx, prompts.translationPreserve.id);
    await activatePromptVersion(ctx, promptDraft.id);

    const pipeline = await getActiveConfigsForPipeline(ctx, studyId);
    const preserve = pipeline.translations.find((entry) => entry.config.key === "translation_preserve");
    expect(preserve).toMatchObject({
      promptKey: "translation_preserve",
      promptVersionNumber: 1,
      promptIsActiveVersion: false,
      activePromptVersionNumber: 2,
    });
    expect(preserve?.config.id).toBe(configs.translationPreserve.id);
    expect(preserve?.prompt?.id).toBe(prompts.translationPreserve.id);

    const listed = (await listModelConfigs(ctx, { studyId, key: "translation_preserve" }))[0];
    expect(listed).toMatchObject({ prompt: { versionNumber: 1, status: "retired" }, activePrompt: { versionNumber: 2 } });

    const draft = await cloneModelConfig(ctx, configs.translationPreserve.id, { useActivePrompt: true });
    expect(draft).toMatchObject({ status: "draft", versionNumber: 2, promptVersionId: promptDraft.id });
    // Still nothing changed for processing until the draft is activated.
    expect((await getActiveModelConfig(ctx, studyId, "translation_preserve"))?.promptVersionId).toBe(
      prompts.translationPreserve.id,
    );
    await activateModelConfig(ctx, draft.id);
    const after = await getActiveConfigsForPipeline(ctx, studyId);
    expect(after.translations.find((entry) => entry.config.key === "translation_preserve")).toMatchObject({
      promptVersionNumber: 2,
      promptIsActiveVersion: true,
    });
  });

  it("returns the active ASR, translation and TTS configs with prompt key and version", async () => {
    const { studyId, configs } = await seeded();
    const pipeline = await getActiveConfigsForPipeline(ctx, studyId);
    expect(pipeline.asr).toMatchObject({
      promptKey: "asr_context",
      promptVersionNumber: 1,
      promptIsActiveVersion: true,
    });
    expect(pipeline.asr?.config.id).toBe(configs.asrDefault.id);
    expect(pipeline.translations.map((entry) => entry.config.conditionKey)).toEqual(["default", "preservation"]);
    expect(pipeline.translations.map((entry) => entry.promptKey)).toEqual(["translation_default", "translation_preserve"]);
    expect(pipeline.tts.map((entry) => entry.config.key)).toEqual(["tts_baseline"]);
    expect(pipeline.tts[0]?.prompt?.promptText).toBe("Speak the text naturally.");

    const empty = await getActiveConfigsForPipeline(ctx, (await insertStudy(ctx.db)).id);
    expect(empty).toEqual({ asr: null, translations: [], tts: [] });
  });

  it("supports a new experimental condition with its own prompt key and config key", async () => {
    const { studyId } = await seeded();
    const prompt = await createPromptDraft(ctx, {
      studyId,
      key: "translation_formal",
      stage: "translation",
      conditionKey: "formal",
      name: "Formal register",
      promptText: "Translate into formal English.",
    });
    await activatePromptVersion(ctx, prompt.id);
    const config = await createModelConfigDraft(ctx, {
      studyId,
      key: "translation_formal",
      stage: "translation",
      conditionKey: "formal",
      provider: "mock",
      modelId: "mock-translation",
      parameters: {},
      promptVersionId: prompt.id,
    });
    await activateModelConfig(ctx, config.id);
    const pipeline = await getActiveConfigsForPipeline(ctx, studyId);
    expect(pipeline.translations.map((entry) => entry.config.conditionKey)).toEqual(["default", "formal", "preservation"]);
  });
});

describe("comparing configs and provider status", () => {
  it("returns changed fields, the parameter difference and the prompt text difference", async () => {
    const { prompts, configs } = await seeded();
    const promptDraft = await clonePromptVersion(ctx, prompts.ttsBaseline.id);
    const draft = await cloneModelConfig(ctx, configs.ttsBaseline.id);
    await updateModelConfigDraft(ctx, draft.id, {
      modelId: "mock-tts-2",
      parameters: { voice: "second-voice", response_format: "wav" },
      promptVersionId: promptDraft.id,
    });
    const diff = await diffModelConfigs(ctx, configs.ttsBaseline.id, draft.id);
    expect(diff.identical).toBe(false);
    expect(diff.fields.filter((field) => field.changed).map((field) => field.field)).toEqual([
      "modelId",
      "parameters",
      "promptVersion",
    ]);
    expect(diff.fields.find((field) => field.field === "promptVersion")).toMatchObject({
      before: "tts_baseline v1",
      after: "tts_baseline v2",
    });
    expect(diff.parameterLines.filter((part) => part.type === "removed")[0]?.value).toContain("mock-voice");
    expect(diff.parameterLines.filter((part) => part.type === "added")[0]?.value).toContain("second-voice");
    expect(diff.promptText?.lines).toEqual([{ type: "unchanged", value: "Speak the text naturally." }]);

    const same = await diffModelConfigs(ctx, configs.ttsBaseline.id, configs.ttsBaseline.id);
    expect(same).toMatchObject({ identical: true, promptText: null });
  });

  it("reports which providers exist and whether each is configured, without any key material", () => {
    const status = listProviderStatus(ctx);
    expect(status).toEqual([
      { name: "openai", configured: false, isMock: false },
      { name: "mock", configured: true, isMock: true },
    ]);
  });
});
