// Versioned questionnaires (spec 11, 12, 55, 76). Same life cycle as protocols:
// a draft is edited, published (immutable from then on) and later retired.
// A change to a published questionnaire is made by cloning it as a new draft.
//
// Each function checks the state first and throws a clear AppError. The database
// triggers (docs/DATA-MODEL.md) are the safety net and surface as IMMUTABLE_RECORD.
//
// Publishing a questionnaire version does not change any protocol: a protocol
// draft must select the new version.
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import {
  isImmutableRecordError,
  isUniqueViolation,
  protocolVersions,
  questionnaireItems,
  questionnaireVersions,
  studies,
  triggerErrorReason,
  type DbOrTx,
} from "@dialect/db";
import {
  AppError,
  compactTranslations,
  isAppError,
  questionnaireSchemas as schemas,
  type QuestionnaireItemTranslations,
  type QuestionnaireItemType,
  type QuestionnaireTranslations,
} from "@dialect/domain";
import { ZodError, type z } from "zod";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { resolveStudy } from "../study";

type VersionRow = typeof questionnaireVersions.$inferSelect;
type ItemRow = typeof questionnaireItems.$inferSelect;

export type QuestionnaireItemView = schemas.QuestionnaireItemView;
export type QuestionnaireVersionSummary = schemas.QuestionnaireVersionSummary;
export type QuestionnaireVersionDetail = schemas.QuestionnaireVersionDetail;
export type QuestionnaireGroup = schemas.QuestionnaireGroup;
export type QuestionnaireDiff = schemas.QuestionnaireDiff;

export type CreateQuestionnaireDraftInput = {
  studyId: string;
  key: string;
  name: string;
  description?: string | null;
};
export type UpdateQuestionnaireDraftInput = {
  name?: string;
  description?: string | null;
  translations?: QuestionnaireTranslations;
};
export type AddItemInput = {
  // Derived from the prompt and made unique when omitted.
  itemKey?: string;
  type: QuestionnaireItemType;
  prompt: string;
  helpText?: string | null;
  required?: boolean;
  config?: schemas.QuestionnaireItemConfig;
  translations?: QuestionnaireItemTranslations;
};
export type UpdateItemInput = Partial<Omit<AddItemInput, "itemKey">> & { itemKey?: string };
export type SaveDraftInput = {
  name?: string;
  description?: string | null;
  translations?: QuestionnaireTranslations;
  // The complete item list in order. An entry with `id` updates that item, an
  // entry without creates one, and an existing item that is not listed is deleted.
  items: schemas.DraftItemInput[];
};

// Services throw AppError: a schema failure becomes VALIDATION_ERROR with the issues.
function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError("VALIDATION_ERROR", error.issues[0]?.message ?? "The input is not valid.", {
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function toItemView(row: ItemRow): QuestionnaireItemView {
  return {
    id: row.id,
    itemKey: row.itemKey,
    type: row.type,
    prompt: row.prompt,
    helpText: row.helpText,
    required: row.required,
    orderIndex: row.orderIndex,
    config: row.configJson ?? {},
    translations: row.translationsJson ?? {},
  };
}

function toSummary(row: VersionRow, itemCount: number): QuestionnaireVersionSummary {
  return {
    id: row.id,
    studyId: row.studyId,
    key: row.key,
    versionNumber: row.versionNumber,
    status: row.status,
    name: row.name,
    description: row.description,
    translations: row.translationsJson ?? {},
    itemCount,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    createdByLabel: row.createdByLabel,
  };
}

async function loadItems(db: DbOrTx, versionId: string): Promise<ItemRow[]> {
  return db
    .select()
    .from(questionnaireItems)
    .where(eq(questionnaireItems.questionnaireVersionId, versionId))
    .orderBy(asc(questionnaireItems.orderIndex), asc(questionnaireItems.itemKey));
}

async function loadVersion(db: DbOrTx, id: string, lock = false): Promise<VersionRow> {
  const query = db.select().from(questionnaireVersions).where(eq(questionnaireVersions.id, id)).limit(1);
  const rows = lock ? await query.for("update") : await query;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "The questionnaire version does not exist.");
  return row;
}

function assertDraft(version: VersionRow): void {
  if (version.status !== "draft") {
    throw new AppError(
      "IMMUTABLE_RECORD",
      `This questionnaire version is ${version.status} and can no longer be changed. Clone it as a new draft instead.`,
    );
  }
}

async function loadProtocolUses(db: DbOrTx, version: VersionRow): Promise<schemas.QuestionnaireProtocolUse[]> {
  const rows = await db
    .select({
      id: protocolVersions.id,
      versionNumber: protocolVersions.versionNumber,
      name: protocolVersions.name,
      status: protocolVersions.status,
      backgroundId: protocolVersions.backgroundQuestionnaireVersionId,
      postId: protocolVersions.postQuestionnaireVersionId,
      postReviewId: protocolVersions.postReviewQuestionnaireVersionId,
    })
    .from(protocolVersions)
    .where(
      or(
        eq(protocolVersions.backgroundQuestionnaireVersionId, version.id),
        eq(protocolVersions.postQuestionnaireVersionId, version.id),
        eq(protocolVersions.postReviewQuestionnaireVersionId, version.id),
      ),
    )
    .orderBy(desc(protocolVersions.versionNumber));
  if (rows.length === 0) return [];
  const [study] = await db
    .select({ current: studies.currentProtocolVersionId })
    .from(studies)
    .where(eq(studies.id, version.studyId));
  const uses: schemas.QuestionnaireProtocolUse[] = [];
  for (const row of rows) {
    const base = {
      protocolVersionId: row.id,
      versionNumber: row.versionNumber,
      name: row.name,
      status: row.status,
      isCurrent: study?.current === row.id,
    };
    if (row.backgroundId === version.id) uses.push({ ...base, role: "background" });
    if (row.postId === version.id) uses.push({ ...base, role: "post_recording" });
    if (row.postReviewId === version.id) uses.push({ ...base, role: "post_review" });
  }
  return uses;
}

async function loadDetail(db: DbOrTx, id: string): Promise<QuestionnaireVersionDetail> {
  const version = await loadVersion(db, id);
  const items = await loadItems(db, id);
  return {
    ...toSummary(version, items.length),
    items: items.map(toItemView),
    usedByProtocols: await loadProtocolUses(db, version),
  };
}

// A trigger rejected the write (the state changed between the check and the write).
function translateDatabaseError(error: unknown): never {
  if (isImmutableRecordError(error)) {
    throw new AppError(
      "IMMUTABLE_RECORD",
      "This questionnaire version is published and can no longer be changed. Clone it as a new draft instead.",
      { reason: triggerErrorReason(error) },
      { cause: error },
    );
  }
  if (isUniqueViolation(error, "questionnaire_items_version_key_uq")) {
    throw new AppError("CONFLICT", "Another item of this version already uses that item key.", undefined, {
      cause: error,
    });
  }
  if (isUniqueViolation(error, "questionnaire_versions_study_key_version_uq")) {
    throw new AppError("CONFLICT", "Another version of this questionnaire was created at the same time. Try again.", undefined, {
      cause: error,
    });
  }
  throw error;
}

async function inTransaction<T>(ctx: ServiceContext, work: (tx: DbOrTx) => Promise<T>): Promise<T> {
  try {
    return await ctx.db.transaction((tx) => work(tx));
  } catch (error) {
    if (isAppError(error)) throw error;
    return translateDatabaseError(error);
  }
}

function auditSnapshot(version: VersionRow, items: ItemRow[]) {
  return {
    key: version.key,
    versionNumber: version.versionNumber,
    status: version.status,
    name: version.name,
    description: version.description,
    translations: version.translationsJson,
    items: items.map((item) => ({
      itemKey: item.itemKey,
      type: item.type,
      prompt: item.prompt,
      helpText: item.helpText,
      required: item.required,
      orderIndex: item.orderIndex,
      config: item.configJson,
      translations: item.translationsJson,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Every questionnaire of the study, grouped by key (alphabetical), versions newest first.
export async function listQuestionnaires(ctx: ServiceContext, studyId: string): Promise<QuestionnaireGroup[]> {
  const versions = await ctx.db
    .select()
    .from(questionnaireVersions)
    .where(eq(questionnaireVersions.studyId, studyId))
    .orderBy(asc(questionnaireVersions.key), desc(questionnaireVersions.versionNumber));
  if (versions.length === 0) return [];
  const itemRows = await ctx.db
    .select({ versionId: questionnaireItems.questionnaireVersionId })
    .from(questionnaireItems)
    .where(
      inArray(
        questionnaireItems.questionnaireVersionId,
        versions.map((version) => version.id),
      ),
    );
  const counts = new Map<string, number>();
  for (const row of itemRows) counts.set(row.versionId, (counts.get(row.versionId) ?? 0) + 1);

  const groups: QuestionnaireGroup[] = [];
  for (const version of versions) {
    let group = groups[groups.length - 1];
    if (!group || group.key !== version.key) {
      group = { key: version.key, versions: [] };
      groups.push(group);
    }
    group.versions.push(toSummary(version, counts.get(version.id) ?? 0));
  }
  return groups;
}

// One version with its items in order and the protocol versions that select it.
export async function getQuestionnaireVersion(ctx: ServiceContext, id: string): Promise<QuestionnaireVersionDetail> {
  return loadDetail(ctx.db, id);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

async function assertNoOtherDraft(tx: DbOrTx, studyId: string, key: string): Promise<void> {
  const [draft] = await tx
    .select({ id: questionnaireVersions.id, versionNumber: questionnaireVersions.versionNumber })
    .from(questionnaireVersions)
    .where(
      and(
        eq(questionnaireVersions.studyId, studyId),
        eq(questionnaireVersions.key, key),
        eq(questionnaireVersions.status, "draft"),
      ),
    )
    .limit(1);
  if (draft) {
    throw new AppError(
      "CONFLICT",
      `The questionnaire "${key}" already has a draft (version ${draft.versionNumber}). Edit or delete that draft first.`,
      { draftVersionId: draft.id },
    );
  }
}

async function nextVersionNumber(tx: DbOrTx, studyId: string, key: string): Promise<number> {
  const [latest] = await tx
    .select({ versionNumber: questionnaireVersions.versionNumber })
    .from(questionnaireVersions)
    .where(and(eq(questionnaireVersions.studyId, studyId), eq(questionnaireVersions.key, key)))
    .orderBy(desc(questionnaireVersions.versionNumber))
    .limit(1);
  return (latest?.versionNumber ?? 0) + 1;
}

// Serializes draft creation for one study, so "one draft per key" also holds for
// two requests that arrive together.
async function lockStudy(tx: DbOrTx, studyId: string): Promise<void> {
  const rows = await tx.select({ id: studies.id }).from(studies).where(eq(studies.id, studyId)).for("update");
  if (rows.length === 0) throw new AppError("NOT_FOUND", "The study does not exist.");
}

// Creates an empty draft. Any key is allowed (for example a future
// "source_speaker_evaluation", spec 55). The version number is the next one of
// that key. One draft per key at a time: a second gives CONFLICT.
export async function createQuestionnaireDraft(
  ctx: ServiceContext,
  input: CreateQuestionnaireDraftInput,
): Promise<QuestionnaireVersionDetail> {
  const parsed = parseInput(schemas.createDraftBodySchema, {
    key: input.key,
    name: input.name,
    description: input.description ?? null,
  });
  return inTransaction(ctx, async (tx) => {
    await lockStudy(tx, input.studyId);
    await assertNoOtherDraft(tx, input.studyId, parsed.key);
    const [version] = await tx
      .insert(questionnaireVersions)
      .values({
        studyId: input.studyId,
        key: parsed.key,
        versionNumber: await nextVersionNumber(tx, input.studyId, parsed.key),
        status: "draft",
        name: parsed.name,
        description: parsed.description || null,
        createdAt: ctx.now(),
        createdByLabel: ctx.actorLabel,
      })
      .returning();
    await recordAudit(tx, {
      action: "questionnaire.create",
      entityType: "questionnaire_version",
      entityId: version!.id,
      after: auditSnapshot(version!, []),
      actorLabel: ctx.actorLabel,
    });
    return loadDetail(tx, version!.id);
  });
}

// Copies a version (published or retired) into a new draft of the same key.
// The item keys are kept, so answers stay comparable across versions.
export async function cloneQuestionnaireVersion(ctx: ServiceContext, id: string): Promise<QuestionnaireVersionDetail> {
  return inTransaction(ctx, async (tx) => {
    const source = await loadVersion(tx, id);
    await lockStudy(tx, source.studyId);
    await assertNoOtherDraft(tx, source.studyId, source.key);
    const sourceItems = await loadItems(tx, id);
    const [version] = await tx
      .insert(questionnaireVersions)
      .values({
        studyId: source.studyId,
        key: source.key,
        versionNumber: await nextVersionNumber(tx, source.studyId, source.key),
        status: "draft",
        name: source.name,
        description: source.description,
        translationsJson: source.translationsJson,
        createdAt: ctx.now(),
        createdByLabel: ctx.actorLabel,
      })
      .returning();
    const items =
      sourceItems.length === 0
        ? []
        : await tx
            .insert(questionnaireItems)
            .values(
              sourceItems.map((item, index) => ({
                questionnaireVersionId: version!.id,
                itemKey: item.itemKey,
                type: item.type,
                prompt: item.prompt,
                helpText: item.helpText,
                required: item.required,
                orderIndex: index,
                configJson: item.configJson,
                translationsJson: item.translationsJson,
              })),
            )
            .returning();
    await recordAudit(tx, {
      action: "questionnaire.create",
      entityType: "questionnaire_version",
      entityId: version!.id,
      before: { clonedFromVersionId: source.id, clonedFromVersionNumber: source.versionNumber },
      after: auditSnapshot(version!, items),
      actorLabel: ctx.actorLabel,
    });
    return loadDetail(tx, version!.id);
  });
}

// Runs one edit of a draft: locks the version, checks that it is a draft, applies
// the change and writes one "questionnaire.update_draft" audit row.
async function editDraft(
  ctx: ServiceContext,
  versionId: string,
  change: string,
  apply: (tx: DbOrTx, version: VersionRow, items: ItemRow[]) => Promise<void>,
): Promise<QuestionnaireVersionDetail> {
  return inTransaction(ctx, async (tx) => {
    const version = await loadVersion(tx, versionId, true);
    assertDraft(version);
    const itemsBefore = await loadItems(tx, versionId);
    await apply(tx, version, itemsBefore);
    const after = await loadVersion(tx, versionId);
    const itemsAfter = await loadItems(tx, versionId);
    await recordAudit(tx, {
      action: "questionnaire.update_draft",
      entityType: "questionnaire_version",
      entityId: versionId,
      before: auditSnapshot(version, itemsBefore),
      after: { change, ...auditSnapshot(after, itemsAfter) },
      actorLabel: ctx.actorLabel,
    });
    return loadDetail(tx, versionId);
  });
}

// Changes the name and description of a draft.
export async function updateQuestionnaireDraft(
  ctx: ServiceContext,
  id: string,
  input: UpdateQuestionnaireDraftInput,
): Promise<QuestionnaireVersionDetail> {
  const parsed = parseInput(schemas.updateDraftBodySchema, {
    name: input.name,
    description: input.description,
    translations: input.translations,
  });
  return editDraft(ctx, id, "details", async (tx) => {
    const values: Partial<typeof questionnaireVersions.$inferInsert> = {};
    if (parsed.name !== undefined) values.name = parsed.name;
    if (parsed.description !== undefined) values.description = parsed.description || null;
    if (parsed.translations !== undefined) values.translationsJson = compactTranslations(parsed.translations);
    if (Object.keys(values).length === 0) return;
    await tx.update(questionnaireVersions).set(values).where(eq(questionnaireVersions.id, id));
  });
}

function assertUniqueKeys(keys: string[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      throw new AppError("CONFLICT", `The item key "${key}" is used more than once in this version.`, { itemKey: key });
    }
    seen.add(key);
  }
}

// Saves the whole draft in one transaction: name, description and the complete
// ordered item list. This is what the editor's Save button calls.
export async function saveQuestionnaireDraft(
  ctx: ServiceContext,
  id: string,
  input: SaveDraftInput,
): Promise<QuestionnaireVersionDetail> {
  const parsed = parseInput(schemas.updateDraftBodySchema, input);
  const items = parsed.items ?? [];
  assertUniqueKeys(items.map((item) => item.itemKey));
  return editDraft(ctx, id, "save", async (tx, _version, existing) => {
    const existingById = new Map(existing.map((item) => [item.id, item]));
    for (const item of items) {
      if (item.id && !existingById.has(item.id)) {
        throw new AppError("NOT_FOUND", `The item "${item.itemKey}" is not an item of this version.`);
      }
    }
    const values: Partial<typeof questionnaireVersions.$inferInsert> = {};
    if (parsed.name !== undefined) values.name = parsed.name;
    if (parsed.description !== undefined) values.description = parsed.description || null;
    if (parsed.translations !== undefined) values.translationsJson = compactTranslations(parsed.translations);
    if (Object.keys(values).length > 0) {
      await tx.update(questionnaireVersions).set(values).where(eq(questionnaireVersions.id, id));
    }

    const keptIds = new Set(items.flatMap((item) => (item.id ? [item.id] : [])));
    const removed = existing.filter((item) => !keptIds.has(item.id)).map((item) => item.id);
    if (removed.length > 0) await tx.delete(questionnaireItems).where(inArray(questionnaireItems.id, removed));

    // Two items may exchange keys: free the old keys first so the unique index never sees a duplicate.
    for (const item of items) {
      const old = item.id ? existingById.get(item.id) : undefined;
      if (old && old.itemKey !== item.itemKey) {
        await tx
          .update(questionnaireItems)
          .set({ itemKey: `~${randomUUID()}` })
          .where(eq(questionnaireItems.id, old.id));
      }
    }
    for (const [index, item] of items.entries()) {
      const row = {
        itemKey: item.itemKey,
        type: item.type,
        prompt: item.prompt,
        helpText: item.helpText || null,
        required: item.required,
        orderIndex: index,
        configJson: item.config,
        // An item saved without translations keeps the ones it has.
        ...(item.translations !== undefined ? { translationsJson: compactTranslations(item.translations) } : {}),
      };
      if (item.id) await tx.update(questionnaireItems).set(row).where(eq(questionnaireItems.id, item.id));
      else await tx.insert(questionnaireItems).values({ ...row, questionnaireVersionId: id });
    }
  });
}

// ---------------------------------------------------------------------------
// Items of a draft
// ---------------------------------------------------------------------------

function uniqueItemKey(base: string, taken: Set<string>): string {
  const root = base || "item";
  if (!taken.has(root)) return root;
  for (let n = 2; ; n += 1) {
    const candidate = `${root}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function loadItem(db: DbOrTx, itemId: string): Promise<ItemRow> {
  const [item] = await db.select().from(questionnaireItems).where(eq(questionnaireItems.id, itemId)).limit(1);
  if (!item) throw new AppError("NOT_FOUND", "The questionnaire item does not exist.");
  return item;
}

// Writes order_index 0, 1, 2, ... in the given order.
async function writeOrder(tx: DbOrTx, orderedIds: string[]): Promise<void> {
  for (const [index, itemId] of orderedIds.entries()) {
    await tx.update(questionnaireItems).set({ orderIndex: index }).where(eq(questionnaireItems.id, itemId));
  }
}

// Adds an item at the end of a draft. The item key must be unique within the
// version; when omitted it is derived from the prompt ("how_natural_did_it_feel").
export async function addItem(
  ctx: ServiceContext,
  versionId: string,
  input: AddItemInput,
): Promise<QuestionnaireVersionDetail> {
  const parsed = parseInput(schemas.addItemBodySchema, input);
  return editDraft(ctx, versionId, "add_item", async (tx, _version, items) => {
    const taken = new Set(items.map((item) => item.itemKey));
    if (parsed.itemKey && taken.has(parsed.itemKey)) {
      throw new AppError("CONFLICT", `The item key "${parsed.itemKey}" is already used in this version.`, {
        itemKey: parsed.itemKey,
      });
    }
    await tx.insert(questionnaireItems).values({
      questionnaireVersionId: versionId,
      itemKey: parsed.itemKey ?? uniqueItemKey(schemas.slugifyKey(parsed.prompt), taken),
      type: parsed.type,
      prompt: parsed.prompt,
      helpText: parsed.helpText || null,
      required: parsed.required ?? false,
      orderIndex: items.length,
      configJson: parsed.config ?? schemas.defaultItemConfig(parsed.type),
      translationsJson: compactTranslations(parsed.translations),
    });
  });
}

// Changes fields of one item of a draft. The item key stays as it is unless a new one is given.
export async function updateItem(
  ctx: ServiceContext,
  itemId: string,
  input: UpdateItemInput,
): Promise<QuestionnaireVersionDetail> {
  const parsed = parseInput(schemas.updateItemBodySchema, input);
  const item = await loadItem(ctx.db, itemId);
  return editDraft(ctx, item.questionnaireVersionId, "update_item", async (tx, _version, items) => {
    if (
      parsed.itemKey !== undefined &&
      items.some((other) => other.id !== itemId && other.itemKey === parsed.itemKey)
    ) {
      throw new AppError("CONFLICT", `The item key "${parsed.itemKey}" is already used in this version.`, {
        itemKey: parsed.itemKey,
      });
    }
    const values: Partial<typeof questionnaireItems.$inferInsert> = {};
    if (parsed.itemKey !== undefined) values.itemKey = parsed.itemKey;
    if (parsed.type !== undefined) values.type = parsed.type;
    if (parsed.prompt !== undefined) values.prompt = parsed.prompt;
    if (parsed.helpText !== undefined) values.helpText = parsed.helpText || null;
    if (parsed.required !== undefined) values.required = parsed.required;
    if (parsed.config !== undefined) values.configJson = parsed.config;
    if (parsed.translations !== undefined) values.translationsJson = compactTranslations(parsed.translations);
    if (Object.keys(values).length === 0) return;
    await tx.update(questionnaireItems).set(values).where(eq(questionnaireItems.id, itemId));
  });
}

// Removes an item from a draft and closes the gap in the order.
export async function deleteItem(ctx: ServiceContext, itemId: string): Promise<QuestionnaireVersionDetail> {
  const item = await loadItem(ctx.db, itemId);
  return editDraft(ctx, item.questionnaireVersionId, "delete_item", async (tx, _version, items) => {
    await tx.delete(questionnaireItems).where(eq(questionnaireItems.id, itemId));
    await writeOrder(
      tx,
      items.filter((other) => other.id !== itemId).map((other) => other.id),
    );
  });
}

// Moves an item one place up or down. Moving the first item up or the last one down changes nothing.
export async function moveItem(
  ctx: ServiceContext,
  itemId: string,
  direction: "up" | "down",
): Promise<QuestionnaireVersionDetail> {
  const item = await loadItem(ctx.db, itemId);
  return editDraft(ctx, item.questionnaireVersionId, `move_item_${direction}`, async (tx, _version, items) => {
    const ids = items.map((other) => other.id);
    const index = ids.indexOf(itemId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index >= 0 && target >= 0 && target < ids.length) {
      [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    }
    await writeOrder(tx, ids);
  });
}

// ---------------------------------------------------------------------------
// Publish, retire, delete
// ---------------------------------------------------------------------------

// Publishes a draft. Requires at least one item, a valid configuration for every
// item, non-empty prompts and unique item keys. The version is immutable afterwards.
// No protocol changes: a protocol draft must select the published version.
export async function publishQuestionnaireVersion(ctx: ServiceContext, id: string): Promise<QuestionnaireVersionDetail> {
  return inTransaction(ctx, async (tx) => {
    const version = await loadVersion(tx, id, true);
    if (version.status !== "draft") {
      throw new AppError("INVALID_STATE", `This questionnaire version is already ${version.status}.`);
    }
    const items = await loadItems(tx, id);
    const problems = schemas.findPublishProblems(items.map(toItemView));
    if (problems.length > 0) {
      throw new AppError("VALIDATION_ERROR", "The questionnaire cannot be published yet.", { problems });
    }
    const [published] = await tx
      .update(questionnaireVersions)
      .set({ status: "published", publishedAt: ctx.now() })
      .where(eq(questionnaireVersions.id, id))
      .returning();
    await recordAudit(tx, {
      action: "questionnaire.publish",
      entityType: "questionnaire_version",
      entityId: id,
      before: { status: "draft" },
      after: auditSnapshot(published!, items),
      actorLabel: ctx.actorLabel,
    });
    return loadDetail(tx, id);
  });
}

// Retires a published version. Refused while the study's current protocol (the
// one given to new sessions) is published and selects this version.
export async function retireQuestionnaireVersion(ctx: ServiceContext, id: string): Promise<QuestionnaireVersionDetail> {
  return inTransaction(ctx, async (tx) => {
    const version = await loadVersion(tx, id, true);
    if (version.status !== "published") {
      throw new AppError("INVALID_STATE", `Only a published questionnaire version can be retired. This one is ${version.status}.`);
    }
    const inUse = (await loadProtocolUses(tx, version)).find((use) => use.isCurrent && use.status === "published");
    if (inUse) {
      throw new AppError(
        "CONFLICT",
        `The current protocol (version ${inUse.versionNumber}) uses this questionnaire version. Publish a protocol that selects another version first.`,
        { protocolVersionId: inUse.protocolVersionId },
      );
    }
    await tx
      .update(questionnaireVersions)
      .set({ status: "retired", retiredAt: ctx.now() })
      .where(eq(questionnaireVersions.id, id));
    await recordAudit(tx, {
      action: "questionnaire.retire",
      entityType: "questionnaire_version",
      entityId: id,
      before: { status: "published" },
      after: { status: "retired", key: version.key, versionNumber: version.versionNumber },
      actorLabel: ctx.actorLabel,
    });
    return loadDetail(tx, id);
  });
}

// Deletes a draft with its items. Refused when a protocol version selects the draft.
export async function deleteQuestionnaireDraft(ctx: ServiceContext, id: string): Promise<{ deleted: true; id: string }> {
  return inTransaction(ctx, async (tx) => {
    const version = await loadVersion(tx, id, true);
    if (version.status !== "draft") {
      throw new AppError(
        "IMMUTABLE_RECORD",
        `This questionnaire version is ${version.status} and cannot be deleted. Only a draft can be deleted.`,
      );
    }
    const uses = await loadProtocolUses(tx, version);
    if (uses.length > 0) {
      throw new AppError(
        "CONFLICT",
        `Protocol version ${uses[0]!.versionNumber} selects this draft. Remove it from that protocol first.`,
        { protocolVersionId: uses[0]!.protocolVersionId },
      );
    }
    const items = await loadItems(tx, id);
    await tx.delete(questionnaireVersions).where(eq(questionnaireVersions.id, id));
    await recordAudit(tx, {
      action: "questionnaire.delete_draft",
      entityType: "questionnaire_version",
      entityId: id,
      before: auditSnapshot(version, items),
      after: { deleted: true },
      actorLabel: ctx.actorLabel,
    });
    return { deleted: true as const, id };
  });
}

// ---------------------------------------------------------------------------
// Differences
// ---------------------------------------------------------------------------

// The newest published or retired version of the same key with a lower version number.
export async function findPreviousPublishedVersionId(ctx: ServiceContext, id: string): Promise<string | null> {
  const version = await loadVersion(ctx.db, id);
  const [previous] = await ctx.db
    .select({ id: questionnaireVersions.id })
    .from(questionnaireVersions)
    .where(
      and(
        eq(questionnaireVersions.studyId, version.studyId),
        eq(questionnaireVersions.key, version.key),
        ne(questionnaireVersions.status, "draft"),
        lt(questionnaireVersions.versionNumber, version.versionNumber),
      ),
    )
    .orderBy(desc(questionnaireVersions.versionNumber))
    .limit(1);
  return previous?.id ?? null;
}

// What changed from version `fromId` (the older one) to version `toId`: items
// added, removed and changed (wording, help text, response type, required, scale,
// options, limits, position), matched by item key. With `fromId` null every item
// of `toId` counts as added (a first version).
export async function diffQuestionnaireVersions(
  ctx: ServiceContext,
  fromId: string | null,
  toId: string,
): Promise<QuestionnaireDiff> {
  const to = await loadVersion(ctx.db, toId);
  const toItems = (await loadItems(ctx.db, toId)).map(toItemView);
  const ref = (version: VersionRow): schemas.QuestionnaireVersionRef => ({
    id: version.id,
    key: version.key,
    versionNumber: version.versionNumber,
    status: version.status,
  });
  if (fromId === null) {
    return {
      from: null,
      to: ref(to),
      nameChanged: false,
      descriptionChanged: false,
      ...schemas.diffQuestionnaireItems([], toItems),
      identical: false,
    };
  }
  const from = await loadVersion(ctx.db, fromId);
  if (from.studyId !== to.studyId) {
    throw new AppError("VALIDATION_ERROR", "The two questionnaire versions belong to different studies.");
  }
  const fromItems = (await loadItems(ctx.db, fromId)).map(toItemView);
  const itemDiff = schemas.diffQuestionnaireItems(fromItems, toItems);
  const nameChanged = from.name !== to.name;
  const descriptionChanged = (from.description ?? "") !== (to.description ?? "");
  return {
    from: ref(from),
    to: ref(to),
    nameChanged,
    descriptionChanged,
    ...itemDiff,
    identical:
      !nameChanged &&
      !descriptionChanged &&
      itemDiff.added.length === 0 &&
      itemDiff.removed.length === 0 &&
      itemDiff.changed.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers for the route handlers
// ---------------------------------------------------------------------------

// The deployment runs one study: the one created first. Returns its id and the
// time zone the admin pages show timestamps in.
export async function resolveQuestionnaireStudy(
  ctx: ServiceContext,
): Promise<{ studyId: string; adminTimezone: string }> {
  const study = await resolveStudy(ctx.db);
  return { studyId: study.id, adminTimezone: study.settingsJson?.adminTimezone || "Europe/Helsinki" };
}

// Throws NOT_FOUND unless the item belongs to the version (member routes carry both ids).
export async function assertItemInVersion(ctx: ServiceContext, versionId: string, itemId: string): Promise<void> {
  const item = await loadItem(ctx.db, itemId);
  if (item.questionnaireVersionId !== versionId) {
    throw new AppError("NOT_FOUND", "The questionnaire item does not exist in this version.");
  }
}
