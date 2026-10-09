// Versioned model configurations (spec 37.14, 50, 51, 103, 142, 143).
//
// Same life cycle as prompt versions: draft, active, retired, one active
// version and at most one draft per key. A config pins one prompt version
// through prompt_version_id. Once the config is active that link is frozen, so
// activating a newer prompt version never changes what an active config runs.
// The researcher creates and activates a new config version to adopt it.
import { and, asc, desc, eq } from "drizzle-orm";
import { aiPromptVersions, modelConfigs, type DbOrTx } from "@dialect/db";
import { AppError, aiConfigSchemas, type ProcessingStage } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { diffTextLines, fieldChange, stableJson, type DiffPart, type FieldChange } from "./diff";
import { assertKnownProvider, validateModelParameters } from "./parameters";
import type { VersionSummary } from "./prompts";
import {
  ASR_DEFAULT_CONFIG_KEY,
  inTransaction,
  lockKey,
  parseInput,
  requireStudy,
  versionLabel,
  type ModelConfig,
  type PromptVersion,
} from "./shared";

export type ListModelConfigsInput = { studyId: string; key?: string; stage?: ProcessingStage };

export type CreateModelConfigDraftInput = {
  studyId: string;
  key: string;
  stage: ProcessingStage;
  conditionKey?: string | null;
  name?: string | null;
  provider: string;
  modelId: string;
  parameters: Record<string, unknown>;
  promptVersionId?: string | null;
  notes?: string | null;
};

export type UpdateModelConfigDraftInput = {
  conditionKey?: string | null;
  name?: string | null;
  provider?: string;
  modelId?: string;
  parameters?: Record<string, unknown>;
  promptVersionId?: string | null;
  notes?: string | null;
};

export type CloneModelConfigOptions = {
  // Link the new draft to the active version of the prompt key the source
  // config uses, instead of the version the source pins.
  useActivePrompt?: boolean;
};

export type LinkedPrompt = Pick<PromptVersion, "id" | "key" | "versionNumber" | "status" | "name">;

export type ModelConfigWithPrompt = ModelConfig & {
  prompt: LinkedPrompt | null;
  // The active version of the linked prompt's key. Null when the config has no
  // prompt or that key has no active version. When its id differs from
  // prompt.id, the config runs with a prompt version that is not the active one.
  activePrompt: LinkedPrompt | null;
};

// One active config as the dashboard and the processing wizard need it.
export type PipelineConfig = {
  config: ModelConfig;
  // The pinned prompt version, with its text.
  prompt: PromptVersion | null;
  promptKey: string | null;
  promptVersionNumber: number | null;
  // False when another version of the prompt key is the active one.
  promptIsActiveVersion: boolean;
  activePromptVersionNumber: number | null;
};

export type ActivePipelineConfigs = {
  // The active config with the key asr_default, which the ASR job uses.
  asr: PipelineConfig | null;
  // One entry per active translation config, ordered by condition key.
  translations: PipelineConfig[];
  // Active TTS configs. The main experiment has one: the baseline voice.
  tts: PipelineConfig[];
};

export type ActivateModelConfigResult = { config: ModelConfig; retired: ModelConfig | null };

export type ModelConfigDiff = {
  a: VersionSummary;
  b: VersionSummary;
  identical: boolean;
  fields: FieldChange[];
  parameterLines: DiffPart[];
  promptText: { lines: DiffPart[] } | null;
};

function auditSnapshot(row: ModelConfig) {
  return {
    id: row.id,
    key: row.key,
    stage: row.stage,
    conditionKey: row.conditionKey,
    versionNumber: row.versionNumber,
    status: row.status,
    name: row.name,
    provider: row.provider,
    modelId: row.modelId,
    parameters: row.parametersJson,
    promptVersionId: row.promptVersionId,
    notes: row.notes,
  };
}

async function findConfig(db: DbOrTx, id: string): Promise<ModelConfig> {
  const [row] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "The model configuration does not exist.", { id });
  return row;
}

async function findPromptOrNull(db: DbOrTx, id: string | null): Promise<PromptVersion | null> {
  if (!id) return null;
  const [row] = await db.select().from(aiPromptVersions).where(eq(aiPromptVersions.id, id)).limit(1);
  return row ?? null;
}

async function versionsOfKey(db: DbOrTx, studyId: string, key: string): Promise<ModelConfig[]> {
  return db
    .select()
    .from(modelConfigs)
    .where(and(eq(modelConfigs.studyId, studyId), eq(modelConfigs.key, key)))
    .orderBy(desc(modelConfigs.versionNumber));
}

function assertNoDraft(existing: ModelConfig[]): void {
  const draft = existing.find((row) => row.status === "draft");
  if (!draft) return;
  throw new AppError(
    "CONFLICT",
    `A draft already exists for this model configuration: ${versionLabel(draft)}. Edit, activate or delete that draft first.`,
    { existingDraftId: draft.id, key: draft.key, versionNumber: draft.versionNumber },
  );
}

function assertDraft(row: ModelConfig): void {
  if (row.status === "draft") return;
  throw new AppError(
    "IMMUTABLE_RECORD",
    `Model configuration ${versionLabel(row)} is ${row.status} and can no longer be changed. Create a new draft version instead.`,
    { id: row.id, status: row.status },
  );
}

function nextVersionNumber(existing: { versionNumber: number }[]): number {
  return existing.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;
}

// Rules that hold for every saved config, draft or not. Returns the
// parameters to store and the linked prompt.
async function validateContent(
  ctx: ServiceContext,
  db: DbOrTx,
  content: {
    studyId: string;
    stage: ProcessingStage;
    provider: string;
    parameters: Record<string, unknown>;
    promptVersionId: string | null;
  },
): Promise<{ parameters: Record<string, unknown>; prompt: PromptVersion | null }> {
  assertKnownProvider(ctx.providers, content.provider);
  const parameters = validateModelParameters({
    provider: content.provider,
    stage: content.stage,
    parameters: content.parameters,
  });

  let prompt: PromptVersion | null = null;
  if (content.promptVersionId) {
    prompt = await findPromptOrNull(db, content.promptVersionId);
    if (!prompt || prompt.studyId !== content.studyId) {
      throw new AppError("VALIDATION_ERROR", "The linked prompt version does not exist in this study.", {
        promptVersionId: content.promptVersionId,
      });
    }
    if (prompt.stage !== content.stage) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Prompt ${versionLabel(prompt)} belongs to the ${prompt.stage} stage and cannot be linked to a ${content.stage} configuration.`,
        { promptVersionId: prompt.id, promptStage: prompt.stage, configStage: content.stage },
      );
    }
  }

  // One source for the speaking instruction, so that the record of what was
  // sent to the synthesis model is never ambiguous.
  if (content.stage === "tts" && parameters.instructions !== undefined && prompt && prompt.promptText.trim().length > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The configuration sets the "instructions" parameter and also links prompt ${versionLabel(prompt)}. ` +
        "Use one of the two: remove the parameter, or remove the prompt link.",
    );
  }
  return { parameters, prompt };
}

function linked(prompt: PromptVersion | undefined | null): LinkedPrompt | null {
  if (!prompt) return null;
  return {
    id: prompt.id,
    key: prompt.key,
    versionNumber: prompt.versionNumber,
    status: prompt.status,
    name: prompt.name,
  };
}

// All versions with the prompt each one pins, ordered by key, newest first.
export async function listModelConfigs(
  ctx: ServiceContext,
  input: ListModelConfigsInput,
): Promise<ModelConfigWithPrompt[]> {
  const conditions = [eq(modelConfigs.studyId, input.studyId)];
  if (input.key) conditions.push(eq(modelConfigs.key, input.key));
  if (input.stage) conditions.push(eq(modelConfigs.stage, input.stage));
  const configs = await ctx.db
    .select()
    .from(modelConfigs)
    .where(and(...conditions))
    .orderBy(asc(modelConfigs.key), desc(modelConfigs.versionNumber));
  const prompts = await ctx.db.select().from(aiPromptVersions).where(eq(aiPromptVersions.studyId, input.studyId));
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const activeByKey = new Map(prompts.filter((p) => p.status === "active").map((prompt) => [prompt.key, prompt]));
  return configs.map((config) => {
    const prompt = config.promptVersionId ? byId.get(config.promptVersionId) : undefined;
    return { ...config, prompt: linked(prompt), activePrompt: linked(prompt ? activeByKey.get(prompt.key) : null) };
  });
}

export async function getModelConfig(ctx: ServiceContext, id: string): Promise<ModelConfig> {
  return findConfig(ctx.db, id);
}

// The active version of a key, or null. There is no fallback configuration
// (spec 143): the caller reports a missing one.
export async function getActiveModelConfig(
  ctx: ServiceContext,
  studyId: string,
  key: string,
): Promise<ModelConfig | null> {
  const [row] = await ctx.db
    .select()
    .from(modelConfigs)
    .where(and(eq(modelConfigs.studyId, studyId), eq(modelConfigs.key, key), eq(modelConfigs.status, "active")))
    .limit(1);
  return row ?? null;
}

// The active configs of the pipeline, each with the key and version of the
// prompt it pins. Used by the dashboard and the processing wizard.
export async function getActiveConfigsForPipeline(ctx: ServiceContext, studyId: string): Promise<ActivePipelineConfigs> {
  const configs = await ctx.db
    .select()
    .from(modelConfigs)
    .where(and(eq(modelConfigs.studyId, studyId), eq(modelConfigs.status, "active")))
    .orderBy(asc(modelConfigs.conditionKey), asc(modelConfigs.key));
  const prompts = await ctx.db.select().from(aiPromptVersions).where(eq(aiPromptVersions.studyId, studyId));
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const activeByKey = new Map(prompts.filter((p) => p.status === "active").map((prompt) => [prompt.key, prompt]));

  const describe = (config: ModelConfig): PipelineConfig => {
    const prompt = (config.promptVersionId ? byId.get(config.promptVersionId) : undefined) ?? null;
    const activePrompt = prompt ? (activeByKey.get(prompt.key) ?? null) : null;
    return {
      config,
      prompt,
      promptKey: prompt?.key ?? null,
      promptVersionNumber: prompt?.versionNumber ?? null,
      promptIsActiveVersion: prompt === null || activePrompt?.id === prompt.id,
      activePromptVersionNumber: activePrompt?.versionNumber ?? null,
    };
  };

  const asr = configs.find((config) => config.stage === "asr" && config.key === ASR_DEFAULT_CONFIG_KEY);
  return {
    asr: asr ? describe(asr) : null,
    translations: configs.filter((config) => config.stage === "translation").map(describe),
    tts: configs.filter((config) => config.stage === "tts").map(describe),
  };
}

export async function createModelConfigDraft(
  ctx: ServiceContext,
  input: CreateModelConfigDraftInput,
): Promise<ModelConfig> {
  const data = parseInput(aiConfigSchemas.createConfigBody, input);
  return inTransaction(ctx, "model configuration", async (tx) => {
    await requireStudy(tx, input.studyId);
    await lockKey(tx, "model_config", input.studyId, data.key);
    const existing = await versionsOfKey(tx, input.studyId, data.key);
    assertNoDraft(existing);
    const latest = existing[0];
    if (latest && latest.stage !== data.stage) {
      throw new AppError(
        "VALIDATION_ERROR",
        `The model configuration key "${data.key}" belongs to the ${latest.stage} stage. A new version must use the same stage.`,
        { key: data.key, stage: latest.stage },
      );
    }
    const { parameters } = await validateContent(ctx, tx, {
      studyId: input.studyId,
      stage: data.stage,
      provider: data.provider,
      parameters: data.parameters,
      promptVersionId: data.promptVersionId ?? null,
    });
    const [created] = await tx
      .insert(modelConfigs)
      .values({
        studyId: input.studyId,
        key: data.key,
        stage: data.stage,
        conditionKey: data.conditionKey === undefined ? (latest?.conditionKey ?? null) : data.conditionKey,
        versionNumber: nextVersionNumber(existing),
        status: "draft",
        name: data.name || null,
        provider: data.provider,
        modelId: data.modelId,
        parametersJson: parameters,
        promptVersionId: data.promptVersionId ?? null,
        notes: data.notes ?? null,
        createdAt: ctx.now(),
        createdByLabel: ctx.actorLabel,
      })
      .returning();
    await recordAudit(tx, {
      action: "model_config.create",
      entityType: "model_config",
      entityId: created!.id,
      after: auditSnapshot(created!),
      actorLabel: ctx.actorLabel,
    });
    return created!;
  });
}

// New draft with the content of any version of the same key.
export async function cloneModelConfig(
  ctx: ServiceContext,
  id: string,
  options: CloneModelConfigOptions = {},
): Promise<ModelConfig> {
  const source = await findConfig(ctx.db, id);
  return inTransaction(ctx, "model configuration", async (tx) => {
    await lockKey(tx, "model_config", source.studyId, source.key);
    const existing = await versionsOfKey(tx, source.studyId, source.key);
    assertNoDraft(existing);

    let promptVersionId = source.promptVersionId;
    if (options.useActivePrompt) {
      const pinned = await findPromptOrNull(tx, source.promptVersionId);
      if (!pinned) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Model configuration ${versionLabel(source)} has no linked prompt, so there is no active prompt to switch to.`,
        );
      }
      const [active] = await tx
        .select()
        .from(aiPromptVersions)
        .where(
          and(
            eq(aiPromptVersions.studyId, pinned.studyId),
            eq(aiPromptVersions.key, pinned.key),
            eq(aiPromptVersions.status, "active"),
          ),
        )
        .limit(1);
      if (!active) {
        throw new AppError(
          "INVALID_STATE",
          `The prompt "${pinned.key}" has no active version. Activate a prompt version first.`,
          { promptKey: pinned.key },
        );
      }
      promptVersionId = active.id;
    }

    const [created] = await tx
      .insert(modelConfigs)
      .values({
        studyId: source.studyId,
        key: source.key,
        stage: source.stage,
        conditionKey: source.conditionKey,
        versionNumber: nextVersionNumber(existing),
        status: "draft",
        name: source.name,
        provider: source.provider,
        modelId: source.modelId,
        parametersJson: source.parametersJson,
        promptVersionId,
        notes: source.notes,
        createdAt: ctx.now(),
        createdByLabel: ctx.actorLabel,
      })
      .returning();
    await recordAudit(tx, {
      action: "model_config.create",
      entityType: "model_config",
      entityId: created!.id,
      after: { ...auditSnapshot(created!), clonedFromId: source.id, clonedFromVersionNumber: source.versionNumber },
      actorLabel: ctx.actorLabel,
    });
    return created!;
  });
}

export async function updateModelConfigDraft(
  ctx: ServiceContext,
  id: string,
  changes: UpdateModelConfigDraftInput,
): Promise<ModelConfig> {
  const data = parseInput(aiConfigSchemas.updateConfigBody, changes);
  const current = await findConfig(ctx.db, id);
  assertDraft(current);
  return inTransaction(ctx, "model configuration", async (tx) => {
    await lockKey(tx, "model_config", current.studyId, current.key);
    const before = await findConfig(tx, id);
    assertDraft(before);
    const promptVersionId = data.promptVersionId === undefined ? before.promptVersionId : data.promptVersionId;
    const provider = data.provider ?? before.provider;
    const { parameters } = await validateContent(ctx, tx, {
      studyId: before.studyId,
      stage: before.stage,
      provider,
      parameters: data.parameters ?? before.parametersJson,
      promptVersionId,
    });
    const [updated] = await tx
      .update(modelConfigs)
      .set({
        ...(data.conditionKey !== undefined ? { conditionKey: data.conditionKey } : {}),
        ...(data.name !== undefined ? { name: data.name || null } : {}),
        ...(data.modelId !== undefined ? { modelId: data.modelId } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        provider,
        parametersJson: parameters,
        promptVersionId,
      })
      .where(eq(modelConfigs.id, id))
      .returning();
    await recordAudit(tx, {
      action: "model_config.update_draft",
      entityType: "model_config",
      entityId: id,
      before: auditSnapshot(before),
      after: auditSnapshot(updated!),
      actorLabel: ctx.actorLabel,
    });
    return updated!;
  });
}

// Makes a draft the active version of its key. The version that was active
// becomes retired in the same transaction. Existing model runs and batches
// keep the config version they were created with.
export async function activateModelConfig(ctx: ServiceContext, id: string): Promise<ActivateModelConfigResult> {
  const found = await findConfig(ctx.db, id);
  return inTransaction(ctx, "model configuration", async (tx) => {
    await lockKey(tx, "model_config", found.studyId, found.key);
    const draft = await findConfig(tx, id);
    if (draft.status !== "draft") {
      throw new AppError(
        "INVALID_STATE",
        draft.status === "active"
          ? `Model configuration ${versionLabel(draft)} is already active.`
          : `Model configuration ${versionLabel(draft)} is retired and cannot be activated again. Clone it into a new draft and activate that.`,
        { id: draft.id, status: draft.status },
      );
    }

    const { parameters, prompt } = await validateContent(ctx, tx, {
      studyId: draft.studyId,
      stage: draft.stage,
      provider: draft.provider,
      parameters: draft.parametersJson,
      promptVersionId: draft.promptVersionId,
    });
    if (prompt && prompt.status === "draft") {
      throw new AppError(
        "INVALID_STATE",
        `The linked prompt ${versionLabel(prompt)} is still a draft. Activate the prompt first, then this configuration.`,
        { promptVersionId: prompt.id },
      );
    }
    if (draft.stage === "translation" && !prompt) {
      throw new AppError(
        "VALIDATION_ERROR",
        "A translation configuration needs a linked prompt version. There is no built-in translation instruction.",
      );
    }
    if (draft.stage === "tts" && (typeof parameters.voice !== "string" || parameters.voice.trim().length === 0)) {
      throw new AppError(
        "VALIDATION_ERROR",
        'A speech synthesis configuration needs a "voice" parameter. There is no built-in voice.',
      );
    }

    const now = ctx.now();
    const [previous] = await tx
      .update(modelConfigs)
      .set({ status: "retired", retiredAt: now })
      .where(
        and(eq(modelConfigs.studyId, draft.studyId), eq(modelConfigs.key, draft.key), eq(modelConfigs.status, "active")),
      )
      .returning();
    const [activated] = await tx
      .update(modelConfigs)
      .set({ status: "active", activatedAt: now })
      .where(eq(modelConfigs.id, id))
      .returning();

    if (previous) {
      await recordAudit(tx, {
        action: "model_config.retire",
        entityType: "model_config",
        entityId: previous.id,
        before: { status: "active" },
        after: { status: "retired", key: previous.key, versionNumber: previous.versionNumber, replacedById: id },
        actorLabel: ctx.actorLabel,
      });
    }
    await recordAudit(tx, {
      action: "model_config.activate",
      entityType: "model_config",
      entityId: id,
      before: { status: "draft" },
      after: { ...auditSnapshot(activated!), replacedId: previous?.id ?? null },
      actorLabel: ctx.actorLabel,
    });
    return { config: activated!, retired: previous ?? null };
  });
}

// Retires the active version without a replacement. The key then has no
// active config, and processing that needs it fails with a clear error.
export async function retireModelConfig(ctx: ServiceContext, id: string): Promise<ModelConfig> {
  const found = await findConfig(ctx.db, id);
  return inTransaction(ctx, "model configuration", async (tx) => {
    await lockKey(tx, "model_config", found.studyId, found.key);
    const current = await findConfig(tx, id);
    if (current.status !== "active") {
      throw new AppError(
        "INVALID_STATE",
        current.status === "draft"
          ? `Model configuration ${versionLabel(current)} is a draft. A draft is deleted, not retired.`
          : `Model configuration ${versionLabel(current)} is already retired.`,
        { id: current.id, status: current.status },
      );
    }
    const [retired] = await tx
      .update(modelConfigs)
      .set({ status: "retired", retiredAt: ctx.now() })
      .where(eq(modelConfigs.id, id))
      .returning();
    await recordAudit(tx, {
      action: "model_config.retire",
      entityType: "model_config",
      entityId: id,
      before: { status: "active" },
      after: { status: "retired", key: retired!.key, versionNumber: retired!.versionNumber, replacedById: null },
      actorLabel: ctx.actorLabel,
    });
    return retired!;
  });
}

// Deletes a draft. Active and retired versions are never deleted.
export async function deleteModelConfigDraft(ctx: ServiceContext, id: string): Promise<{ deleted: true; id: string }> {
  const found = await findConfig(ctx.db, id);
  return inTransaction(ctx, "model configuration", async (tx) => {
    await lockKey(tx, "model_config", found.studyId, found.key);
    const current = await findConfig(tx, id);
    if (current.status !== "draft") {
      throw new AppError(
        "IMMUTABLE_RECORD",
        `Model configuration ${versionLabel(current)} is ${current.status} and cannot be deleted. Only a draft can be deleted.`,
        { id: current.id, status: current.status },
      );
    }
    await tx.delete(modelConfigs).where(eq(modelConfigs.id, id));
    await recordAudit(tx, {
      action: "model_config.delete_draft",
      entityType: "model_config",
      entityId: id,
      before: auditSnapshot(current),
      after: { deleted: true },
      actorLabel: ctx.actorLabel,
    });
    return { deleted: true as const, id };
  });
}

function summary(row: ModelConfig): VersionSummary {
  return { id: row.id, key: row.key, versionNumber: row.versionNumber, status: row.status };
}

// Difference from config A to config B: changed fields, the parameters as
// sorted JSON at line level, and the prompt text when the pinned prompt differs.
export async function diffModelConfigs(ctx: ServiceContext, idA: string, idB: string): Promise<ModelConfigDiff> {
  const a = await findConfig(ctx.db, idA);
  const b = await findConfig(ctx.db, idB);
  if (a.studyId !== b.studyId) {
    throw new AppError("VALIDATION_ERROR", "The two model configurations belong to different studies.");
  }
  const promptA = await findPromptOrNull(ctx.db, a.promptVersionId);
  const promptB = await findPromptOrNull(ctx.db, b.promptVersionId);
  const parametersA = stableJson(a.parametersJson);
  const parametersB = stableJson(b.parametersJson);
  const fields = [
    fieldChange("key", a.key, b.key),
    fieldChange("stage", a.stage, b.stage),
    fieldChange("conditionKey", a.conditionKey, b.conditionKey),
    fieldChange("name", a.name, b.name),
    fieldChange("provider", a.provider, b.provider),
    fieldChange("modelId", a.modelId, b.modelId),
    fieldChange("parameters", parametersA, parametersB),
    fieldChange("promptVersion", promptA ? versionLabel(promptA) : null, promptB ? versionLabel(promptB) : null),
    fieldChange("notes", a.notes, b.notes),
  ];
  return {
    a: summary(a),
    b: summary(b),
    identical: fields.every((field) => !field.changed),
    fields,
    parameterLines: diffTextLines(parametersA, parametersB),
    promptText:
      promptA?.id === promptB?.id
        ? null
        : { lines: diffTextLines(promptA?.promptText ?? "", promptB?.promptText ?? "") },
  };
}
