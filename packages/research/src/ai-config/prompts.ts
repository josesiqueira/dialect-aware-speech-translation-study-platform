// Versioned AI prompts (spec 37.13, 50, 51, 142, 143).
//
// Life cycle: draft, active, retired. A draft can be edited and deleted. An
// active or retired version never changes: only its status and the activated
// or retired timestamps do. At most one version per key is active, and at most
// one draft per key exists at a time.
//
// Activating a prompt version does not touch any model config. A model config
// pins one prompt version, and an active config keeps using the version it
// pins until the researcher activates a new config version (see configs.ts).
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { SYNTHESIS_PROMPT_PLACEHOLDERS, TRANSLATION_PROMPT_PLACEHOLDERS, findUnknownPlaceholders } from "@dialect/ai";
import { aiPromptVersions, modelConfigs, type DbOrTx } from "@dialect/db";
import { AppError, aiConfigSchemas, type ProcessingStage } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { diffTextLines, diffTextWords, fieldChange, type DiffPart, type FieldChange } from "./diff";
import {
  inTransaction,
  lockKey,
  parseInput,
  requireStudy,
  versionLabel,
  type ModelConfig,
  type PromptVersion,
} from "./shared";

export type ListPromptVersionsInput = { studyId: string; key?: string; stage?: ProcessingStage };

export type CreatePromptDraftInput = {
  studyId: string;
  key: string;
  stage: ProcessingStage;
  conditionKey?: string | null;
  name: string;
  promptText: string;
  notes?: string | null;
};

export type UpdatePromptDraftInput = {
  conditionKey?: string | null;
  name?: string;
  promptText?: string;
  notes?: string | null;
};

export type ActivatePromptResult = {
  prompt: PromptVersion;
  // The version that was active before, now retired. Null when there was none.
  retired: PromptVersion | null;
  // Active model configs that still pin another version of this prompt key.
  // They were not changed. The researcher decides whether to create a new
  // config version that uses the newly active prompt.
  configsOnOtherVersions: ModelConfig[];
};

export type VersionSummary = { id: string; key: string; versionNumber: number; status: PromptVersion["status"] };

export type PromptDiff = {
  a: VersionSummary;
  b: VersionSummary;
  identical: boolean;
  fields: FieldChange[];
  lines: DiffPart[];
  words: DiffPart[];
};

// Placeholders the prompt builder of @dialect/ai replaces, per stage. The ASR
// context text is sent as written, so it has no placeholders to check.
function allowedPlaceholders(stage: ProcessingStage): readonly string[] | null {
  if (stage === "translation") return TRANSLATION_PROMPT_PLACEHOLDERS;
  if (stage === "tts") return SYNTHESIS_PROMPT_PLACEHOLDERS;
  return null;
}

export function assertKnownPlaceholders(stage: ProcessingStage, promptText: string): void {
  const allowed = allowedPlaceholders(stage);
  if (!allowed) return;
  const unknown = findUnknownPlaceholders(promptText, allowed);
  if (unknown.length === 0) return;
  throw new AppError(
    "VALIDATION_ERROR",
    `Unknown placeholder in the prompt text: ${unknown.map((n) => `{{${n}}}`).join(", ")}. ` +
      `A ${stage} prompt supports only: ${allowed.map((n) => `{{${n}}}`).join(", ")}.`,
    { unknownPlaceholders: unknown, supportedPlaceholders: [...allowed] },
  );
}

function auditSnapshot(row: PromptVersion) {
  return {
    id: row.id,
    key: row.key,
    stage: row.stage,
    conditionKey: row.conditionKey,
    versionNumber: row.versionNumber,
    status: row.status,
    name: row.name,
    promptText: row.promptText,
    notes: row.notes,
  };
}

async function findPrompt(db: DbOrTx, id: string): Promise<PromptVersion> {
  const [row] = await db.select().from(aiPromptVersions).where(eq(aiPromptVersions.id, id)).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "The prompt version does not exist.", { id });
  return row;
}

async function versionsOfKey(db: DbOrTx, studyId: string, key: string): Promise<PromptVersion[]> {
  return db
    .select()
    .from(aiPromptVersions)
    .where(and(eq(aiPromptVersions.studyId, studyId), eq(aiPromptVersions.key, key)))
    .orderBy(desc(aiPromptVersions.versionNumber));
}

function assertNoDraft(existing: PromptVersion[]): void {
  const draft = existing.find((row) => row.status === "draft");
  if (!draft) return;
  throw new AppError(
    "CONFLICT",
    `A draft already exists for this prompt: ${versionLabel(draft)}. Edit, activate or delete that draft first.`,
    { existingDraftId: draft.id, key: draft.key, versionNumber: draft.versionNumber },
  );
}

function nextVersionNumber(existing: { versionNumber: number }[]): number {
  return existing.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;
}

// All versions, ordered by key and then newest version first.
export async function listPromptVersions(ctx: ServiceContext, input: ListPromptVersionsInput): Promise<PromptVersion[]> {
  const conditions = [eq(aiPromptVersions.studyId, input.studyId)];
  if (input.key) conditions.push(eq(aiPromptVersions.key, input.key));
  if (input.stage) conditions.push(eq(aiPromptVersions.stage, input.stage));
  return ctx.db
    .select()
    .from(aiPromptVersions)
    .where(and(...conditions))
    .orderBy(asc(aiPromptVersions.key), desc(aiPromptVersions.versionNumber));
}

export async function getPromptVersion(ctx: ServiceContext, id: string): Promise<PromptVersion> {
  return findPrompt(ctx.db, id);
}

// The active version of a key, or null. There is no fallback text: a missing
// active prompt must be reported by the caller (spec 143).
export async function getActivePrompt(ctx: ServiceContext, studyId: string, key: string): Promise<PromptVersion | null> {
  const [row] = await ctx.db
    .select()
    .from(aiPromptVersions)
    .where(
      and(eq(aiPromptVersions.studyId, studyId), eq(aiPromptVersions.key, key), eq(aiPromptVersions.status, "active")),
    )
    .limit(1);
  return row ?? null;
}

export async function createPromptDraft(ctx: ServiceContext, input: CreatePromptDraftInput): Promise<PromptVersion> {
  const data = parseInput(aiConfigSchemas.createPromptBody, input);
  assertKnownPlaceholders(data.stage, data.promptText);
  return inTransaction(ctx, "prompt version", async (tx) => {
    await requireStudy(tx, input.studyId);
    await lockKey(tx, "ai_prompt", input.studyId, data.key);
    const existing = await versionsOfKey(tx, input.studyId, data.key);
    assertNoDraft(existing);
    const latest = existing[0];
    if (latest && latest.stage !== data.stage) {
      throw new AppError(
        "VALIDATION_ERROR",
        `The prompt key "${data.key}" belongs to the ${latest.stage} stage. A new version must use the same stage.`,
        { key: data.key, stage: latest.stage },
      );
    }
    const [created] = await tx
      .insert(aiPromptVersions)
      .values({
        studyId: input.studyId,
        key: data.key,
        stage: data.stage,
        conditionKey: data.conditionKey === undefined ? (latest?.conditionKey ?? null) : data.conditionKey,
        versionNumber: nextVersionNumber(existing),
        status: "draft",
        name: data.name,
        promptText: data.promptText,
        notes: data.notes ?? null,
        createdAt: ctx.now(),
        createdByLabel: ctx.actorLabel,
      })
      .returning();
    await recordAudit(tx, {
      action: "ai_prompt.create",
      entityType: "ai_prompt_version",
      entityId: created!.id,
      after: auditSnapshot(created!),
      actorLabel: ctx.actorLabel,
    });
    return created!;
  });
}

// New draft with the content of any version of the same key.
export async function clonePromptVersion(ctx: ServiceContext, id: string): Promise<PromptVersion> {
  const source = await findPrompt(ctx.db, id);
  return inTransaction(ctx, "prompt version", async (tx) => {
    await lockKey(tx, "ai_prompt", source.studyId, source.key);
    const existing = await versionsOfKey(tx, source.studyId, source.key);
    assertNoDraft(existing);
    const [created] = await tx
      .insert(aiPromptVersions)
      .values({
        studyId: source.studyId,
        key: source.key,
        stage: source.stage,
        conditionKey: source.conditionKey,
        versionNumber: nextVersionNumber(existing),
        status: "draft",
        name: source.name,
        promptText: source.promptText,
        notes: source.notes,
        createdAt: ctx.now(),
        createdByLabel: ctx.actorLabel,
      })
      .returning();
    await recordAudit(tx, {
      action: "ai_prompt.create",
      entityType: "ai_prompt_version",
      entityId: created!.id,
      after: { ...auditSnapshot(created!), clonedFromId: source.id, clonedFromVersionNumber: source.versionNumber },
      actorLabel: ctx.actorLabel,
    });
    return created!;
  });
}

function assertDraft(row: PromptVersion): void {
  if (row.status === "draft") return;
  throw new AppError(
    "IMMUTABLE_RECORD",
    `Prompt ${versionLabel(row)} is ${row.status} and can no longer be changed. Create a new draft version instead.`,
    { id: row.id, status: row.status },
  );
}

export async function updatePromptDraft(
  ctx: ServiceContext,
  id: string,
  changes: UpdatePromptDraftInput,
): Promise<PromptVersion> {
  const data = parseInput(aiConfigSchemas.updatePromptBody, changes);
  const current = await findPrompt(ctx.db, id);
  assertDraft(current);
  if (data.promptText !== undefined) assertKnownPlaceholders(current.stage, data.promptText);
  return inTransaction(ctx, "prompt version", async (tx) => {
    await lockKey(tx, "ai_prompt", current.studyId, current.key);
    const before = await findPrompt(tx, id);
    assertDraft(before);
    const [updated] = await tx
      .update(aiPromptVersions)
      .set({
        ...(data.conditionKey !== undefined ? { conditionKey: data.conditionKey } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.promptText !== undefined ? { promptText: data.promptText } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      })
      .where(eq(aiPromptVersions.id, id))
      .returning();
    await recordAudit(tx, {
      action: "ai_prompt.update_draft",
      entityType: "ai_prompt_version",
      entityId: id,
      before: auditSnapshot(before),
      after: auditSnapshot(updated!),
      actorLabel: ctx.actorLabel,
    });
    return updated!;
  });
}

// Makes a draft the active version of its key. The version that was active
// becomes retired in the same transaction. Model runs and model configs that
// point at the old version are not changed (spec 51, 110).
export async function activatePromptVersion(ctx: ServiceContext, id: string): Promise<ActivatePromptResult> {
  const found = await findPrompt(ctx.db, id);
  return inTransaction(ctx, "prompt version", async (tx) => {
    await lockKey(tx, "ai_prompt", found.studyId, found.key);
    const draft = await findPrompt(tx, id);
    if (draft.status !== "draft") {
      throw new AppError(
        "INVALID_STATE",
        draft.status === "active"
          ? `Prompt ${versionLabel(draft)} is already active.`
          : `Prompt ${versionLabel(draft)} is retired and cannot be activated again. Clone it into a new draft and activate that.`,
        { id: draft.id, status: draft.status },
      );
    }
    assertKnownPlaceholders(draft.stage, draft.promptText);
    if (draft.stage === "translation" && draft.promptText.trim().length === 0) {
      throw new AppError("VALIDATION_ERROR", "A translation prompt cannot be empty. Write the instruction text first.");
    }

    const now = ctx.now();
    const [previous] = await tx
      .update(aiPromptVersions)
      .set({ status: "retired", retiredAt: now })
      .where(
        and(
          eq(aiPromptVersions.studyId, draft.studyId),
          eq(aiPromptVersions.key, draft.key),
          eq(aiPromptVersions.status, "active"),
        ),
      )
      .returning();
    const [activated] = await tx
      .update(aiPromptVersions)
      .set({ status: "active", activatedAt: now })
      .where(eq(aiPromptVersions.id, id))
      .returning();

    if (previous) {
      await recordAudit(tx, {
        action: "ai_prompt.retire",
        entityType: "ai_prompt_version",
        entityId: previous.id,
        before: { status: "active" },
        after: { status: "retired", key: previous.key, versionNumber: previous.versionNumber, replacedById: id },
        actorLabel: ctx.actorLabel,
      });
    }
    await recordAudit(tx, {
      action: "ai_prompt.activate",
      entityType: "ai_prompt_version",
      entityId: id,
      before: { status: "draft" },
      after: { ...auditSnapshot(activated!), replacedId: previous?.id ?? null },
      actorLabel: ctx.actorLabel,
    });

    const configsOnOtherVersions = await activeConfigsOnOtherVersions(tx, activated!);
    return { prompt: activated!, retired: previous ?? null, configsOnOtherVersions };
  });
}

// Active model configs that pin a version of this prompt key other than `prompt`.
async function activeConfigsOnOtherVersions(db: DbOrTx, prompt: PromptVersion): Promise<ModelConfig[]> {
  const others = await db
    .select({ id: aiPromptVersions.id })
    .from(aiPromptVersions)
    .where(
      and(
        eq(aiPromptVersions.studyId, prompt.studyId),
        eq(aiPromptVersions.key, prompt.key),
        ne(aiPromptVersions.id, prompt.id),
      ),
    );
  if (others.length === 0) return [];
  return db
    .select()
    .from(modelConfigs)
    .where(
      and(
        eq(modelConfigs.status, "active"),
        inArray(
          modelConfigs.promptVersionId,
          others.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(modelConfigs.key));
}

// Retires the active version without a replacement. Refused while an active
// model config still pins it, because that config would then run with a
// retired prompt without anyone having decided so.
export async function retirePromptVersion(ctx: ServiceContext, id: string): Promise<PromptVersion> {
  const found = await findPrompt(ctx.db, id);
  return inTransaction(ctx, "prompt version", async (tx) => {
    await lockKey(tx, "ai_prompt", found.studyId, found.key);
    const current = await findPrompt(tx, id);
    if (current.status !== "active") {
      throw new AppError(
        "INVALID_STATE",
        current.status === "draft"
          ? `Prompt ${versionLabel(current)} is a draft. A draft is deleted, not retired.`
          : `Prompt ${versionLabel(current)} is already retired.`,
        { id: current.id, status: current.status },
      );
    }
    const users = await tx
      .select({ id: modelConfigs.id, key: modelConfigs.key, versionNumber: modelConfigs.versionNumber })
      .from(modelConfigs)
      .where(and(eq(modelConfigs.promptVersionId, id), eq(modelConfigs.status, "active")));
    if (users.length > 0) {
      throw new AppError(
        "INVALID_STATE",
        `Prompt ${versionLabel(current)} is used by the active model configuration ` +
          `${users.map(versionLabel).join(", ")}. Activate a configuration that uses another prompt version, ` +
          "or retire that configuration first.",
        { id: current.id, activeModelConfigs: users },
      );
    }
    const [retired] = await tx
      .update(aiPromptVersions)
      .set({ status: "retired", retiredAt: ctx.now() })
      .where(eq(aiPromptVersions.id, id))
      .returning();
    await recordAudit(tx, {
      action: "ai_prompt.retire",
      entityType: "ai_prompt_version",
      entityId: id,
      before: { status: "active" },
      after: { status: "retired", key: retired!.key, versionNumber: retired!.versionNumber, replacedById: null },
      actorLabel: ctx.actorLabel,
    });
    return retired!;
  });
}

// Deletes a draft. Active and retired versions are never deleted.
export async function deletePromptDraft(ctx: ServiceContext, id: string): Promise<{ deleted: true; id: string }> {
  const found = await findPrompt(ctx.db, id);
  return inTransaction(ctx, "prompt version", async (tx) => {
    await lockKey(tx, "ai_prompt", found.studyId, found.key);
    const current = await findPrompt(tx, id);
    if (current.status !== "draft") {
      throw new AppError(
        "IMMUTABLE_RECORD",
        `Prompt ${versionLabel(current)} is ${current.status} and cannot be deleted. Only a draft can be deleted.`,
        { id: current.id, status: current.status },
      );
    }
    const users = await tx
      .select({ id: modelConfigs.id, key: modelConfigs.key, versionNumber: modelConfigs.versionNumber })
      .from(modelConfigs)
      .where(eq(modelConfigs.promptVersionId, id));
    if (users.length > 0) {
      throw new AppError(
        "CONFLICT",
        `Prompt draft ${versionLabel(current)} is linked from the model configuration draft ` +
          `${users.map(versionLabel).join(", ")}. Link that configuration to another prompt version first.`,
        { id: current.id, modelConfigs: users },
      );
    }
    await tx.delete(aiPromptVersions).where(eq(aiPromptVersions.id, id));
    await recordAudit(tx, {
      action: "ai_prompt.delete_draft",
      entityType: "ai_prompt_version",
      entityId: id,
      before: {
        status: "draft",
        key: current.key,
        versionNumber: current.versionNumber,
        stage: current.stage,
        conditionKey: current.conditionKey,
        name: current.name,
        promptText: current.promptText,
      },
      after: { deleted: true },
      actorLabel: ctx.actorLabel,
    });
    return { deleted: true as const, id };
  });
}

function summary(row: PromptVersion): VersionSummary {
  return { id: row.id, key: row.key, versionNumber: row.versionNumber, status: row.status };
}

// Difference from version A to version B: the changed fields, and the prompt
// text at line level and at word level.
export async function diffPromptVersions(ctx: ServiceContext, idA: string, idB: string): Promise<PromptDiff> {
  const a = await findPrompt(ctx.db, idA);
  const b = await findPrompt(ctx.db, idB);
  if (a.studyId !== b.studyId) {
    throw new AppError("VALIDATION_ERROR", "The two prompt versions belong to different studies.");
  }
  const fields = [
    fieldChange("key", a.key, b.key),
    fieldChange("stage", a.stage, b.stage),
    fieldChange("conditionKey", a.conditionKey, b.conditionKey),
    fieldChange("name", a.name, b.name),
    fieldChange("notes", a.notes, b.notes),
    fieldChange("promptText", a.promptText, b.promptText),
  ];
  return {
    a: summary(a),
    b: summary(b),
    identical: fields.every((field) => !field.changed),
    fields,
    lines: diffTextLines(a.promptText, b.promptText),
    words: diffTextWords(a.promptText, b.promptText),
  };
}
