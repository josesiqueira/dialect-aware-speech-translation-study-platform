// Protocol versions: list, read, create a draft, clone, edit a draft, retire,
// delete a draft (spec 47, 76). Publishing is in publish.ts.
//
// Rules kept here:
// - Only a draft can be edited. A published or retired version is immutable.
// - A study has at most one draft at a time. The draft is "the next version":
//   the researcher edits it, previews it and publishes it, then clones again.
//   This keeps the workflow simple and the version numbers meaningful.
// - Version numbers are assigned as the highest existing number plus one.
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import {
  consentVersions,
  isUniqueViolation,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireVersions,
  sessions,
  studies,
  type DbOrTx,
  type ProtocolOrderConfig,
} from "@dialect/db";
import { AppError, compactTranslations, protocolSchemas } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import {
  changedFields,
  loadDraftForEdit,
  loadProtocol,
  loadProtocolDetail,
  lockStudy,
  one,
  protocolLabel,
  type ConsentVersionRow,
  type ProtocolDetail,
  type ProtocolVersionRow,
  type QuestionnaireVersionRow,
} from "./shared";
import { renumberTasks } from "./tasks";

export type ProtocolVersionSummary = Pick<
  ProtocolVersionRow,
  | "id"
  | "studyId"
  | "versionNumber"
  | "status"
  | "name"
  | "description"
  | "clonedFromProtocolVersionId"
  | "createdAt"
  | "updatedAt"
  | "publishedAt"
  | "retiredAt"
  | "createdByLabel"
> & {
  // True for the version that new sessions receive.
  isCurrent: boolean;
  taskCount: number;
  enabledTaskCount: number;
  // Sessions pinned to this version, in every mode.
  sessionCount: number;
};

// What a draft may select (spec 47): published consent versions and published
// questionnaire versions of the two keys used by the participant flow.
export type ProtocolOptions = {
  consentVersions: Array<Pick<ConsentVersionRow, "id" | "versionNumber" | "title" | "publishedAt">>;
  backgroundQuestionnaires: Array<
    Pick<QuestionnaireVersionRow, "id" | "key" | "versionNumber" | "name" | "publishedAt">
  >;
  postQuestionnaires: Array<
    Pick<QuestionnaireVersionRow, "id" | "key" | "versionNumber" | "name" | "publishedAt">
  >;
  postReviewQuestionnaires: Array<
    Pick<QuestionnaireVersionRow, "id" | "key" | "versionNumber" | "name" | "publishedAt">
  >;
};

export type ProtocolDraftChanges = protocolSchemas.ProtocolDraftChanges;

// Newest version first.
export async function listProtocolVersions(
  ctx: ServiceContext,
  studyId: string,
): Promise<ProtocolVersionSummary[]> {
  const db = ctx.db;
  const [study] = await db
    .select({ currentProtocolVersionId: studies.currentProtocolVersionId })
    .from(studies)
    .where(eq(studies.id, studyId));
  if (!study) throw new AppError("NOT_FOUND", "The study does not exist.");

  const versions = await db
    .select()
    .from(protocolVersions)
    .where(eq(protocolVersions.studyId, studyId))
    .orderBy(desc(protocolVersions.versionNumber));
  if (versions.length === 0) return [];
  const ids = versions.map((version) => version.id);

  const taskRows = await db
    .select({ protocolVersionId: protocolTasks.protocolVersionId, enabled: protocolTasks.enabled, n: count() })
    .from(protocolTasks)
    .where(inArray(protocolTasks.protocolVersionId, ids))
    .groupBy(protocolTasks.protocolVersionId, protocolTasks.enabled);
  const sessionRows = await db
    .select({ protocolVersionId: sessions.protocolVersionId, n: count() })
    .from(sessions)
    .where(inArray(sessions.protocolVersionId, ids))
    .groupBy(sessions.protocolVersionId);

  return versions.map((version) => {
    const tasks = taskRows.filter((row) => row.protocolVersionId === version.id);
    return {
      id: version.id,
      studyId: version.studyId,
      versionNumber: version.versionNumber,
      status: version.status,
      name: version.name,
      description: version.description,
      clonedFromProtocolVersionId: version.clonedFromProtocolVersionId,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
      publishedAt: version.publishedAt,
      retiredAt: version.retiredAt,
      createdByLabel: version.createdByLabel,
      isCurrent: study.currentProtocolVersionId === version.id,
      taskCount: tasks.reduce((sum, row) => sum + row.n, 0),
      enabledTaskCount: tasks.filter((row) => row.enabled).reduce((sum, row) => sum + row.n, 0),
      sessionCount: sessionRows.find((row) => row.protocolVersionId === version.id)?.n ?? 0,
    };
  });
}

// A protocol version with its tasks, follow-ups, consent version and
// questionnaire versions (with items).
export async function getProtocolVersion(ctx: ServiceContext, id: string): Promise<ProtocolDetail> {
  return loadProtocolDetail(ctx.db, id);
}

// The protocol that new sessions receive, or null when nothing is published yet.
export async function getCurrentProtocol(ctx: ServiceContext, studyId: string): Promise<ProtocolDetail | null> {
  const [study] = await ctx.db
    .select({ currentProtocolVersionId: studies.currentProtocolVersionId })
    .from(studies)
    .where(eq(studies.id, studyId));
  if (!study) throw new AppError("NOT_FOUND", "The study does not exist.");
  if (!study.currentProtocolVersionId) return null;
  return loadProtocolDetail(ctx.db, study.currentProtocolVersionId);
}

export async function listProtocolOptions(ctx: ServiceContext, studyId: string): Promise<ProtocolOptions> {
  const consents = await ctx.db
    .select({
      id: consentVersions.id,
      versionNumber: consentVersions.versionNumber,
      title: consentVersions.title,
      publishedAt: consentVersions.publishedAt,
    })
    .from(consentVersions)
    .where(eq(consentVersions.studyId, studyId))
    .orderBy(desc(consentVersions.versionNumber));
  const questionnaires = await ctx.db
    .select({
      id: questionnaireVersions.id,
      key: questionnaireVersions.key,
      versionNumber: questionnaireVersions.versionNumber,
      name: questionnaireVersions.name,
      publishedAt: questionnaireVersions.publishedAt,
    })
    .from(questionnaireVersions)
    .where(and(eq(questionnaireVersions.studyId, studyId), eq(questionnaireVersions.status, "published")))
    .orderBy(asc(questionnaireVersions.key), desc(questionnaireVersions.versionNumber));
  return {
    consentVersions: consents.filter((consent) => consent.publishedAt !== null),
    backgroundQuestionnaires: questionnaires.filter(
      (row) => row.key === protocolSchemas.BACKGROUND_QUESTIONNAIRE_KEY,
    ),
    postQuestionnaires: questionnaires.filter((row) => row.key === protocolSchemas.POST_QUESTIONNAIRE_KEY),
    postReviewQuestionnaires: questionnaires.filter((row) => row.key === protocolSchemas.POST_REVIEW_QUESTIONNAIRE_KEY),
  };
}

async function nextVersionNumber(tx: DbOrTx, studyId: string): Promise<number> {
  const rows = await tx
    .select({ versionNumber: protocolVersions.versionNumber })
    .from(protocolVersions)
    .where(eq(protocolVersions.studyId, studyId));
  return rows.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;
}

// Call with the study row locked.
async function assertNoOtherDraft(tx: DbOrTx, studyId: string): Promise<void> {
  const [draft] = await tx
    .select()
    .from(protocolVersions)
    .where(and(eq(protocolVersions.studyId, studyId), eq(protocolVersions.status, "draft")))
    .limit(1);
  if (draft) {
    throw new AppError(
      "CONFLICT",
      `A draft already exists: ${protocolLabel(draft)} ("${draft.name}"). Edit that draft, or delete it before creating another one.`,
      { draftProtocolVersionId: draft.id, versionNumber: draft.versionNumber },
    );
  }
}

function conflictOnVersionNumber(error: unknown): never {
  if (isUniqueViolation(error, "protocol_versions_study_version_uq")) {
    throw new AppError("CONFLICT", "Another protocol version was created at the same time. Try again.");
  }
  throw error;
}

// An empty draft with the next version number.
export async function createProtocolDraft(
  ctx: ServiceContext,
  input: { studyId: string; name: string },
): Promise<ProtocolDetail> {
  const name = input.name.trim();
  if (!name) throw new AppError("VALIDATION_ERROR", "A protocol needs a name.");
  const id = await ctx.db
    .transaction(async (tx) => {
      await lockStudy(tx, input.studyId);
      await assertNoOtherDraft(tx, input.studyId);
      const protocol = one(
        await tx
          .insert(protocolVersions)
          .values({
            studyId: input.studyId,
            versionNumber: await nextVersionNumber(tx, input.studyId),
            status: "draft",
            name,
            orderConfigJson: { blocks: [] },
            createdByLabel: ctx.actorLabel,
          })
          .returning(),
      );
      await recordAudit(tx, {
        action: "protocol.create",
        entityType: "protocol_version",
        entityId: protocol.id,
        after: { versionNumber: protocol.versionNumber, name: protocol.name },
        actorLabel: ctx.actorLabel,
      });
      return protocol.id;
    })
    .catch(conflictOnVersionNumber);
  return loadProtocolDetail(ctx.db, id);
}

// Deep copy into a new draft: texts, order configuration, consent and
// questionnaire selections, tasks and follow-ups. Task keys and follow-up keys
// are kept, so the same task can be tracked across versions.
export async function cloneProtocolVersion(ctx: ServiceContext, id: string): Promise<ProtocolDetail> {
  const newId = await ctx.db
    .transaction(async (tx) => {
      const source = await loadProtocol(tx, id);
      await lockStudy(tx, source.studyId);
      await assertNoOtherDraft(tx, source.studyId);
      const draft = one(
        await tx
          .insert(protocolVersions)
          .values({
            studyId: source.studyId,
            versionNumber: await nextVersionNumber(tx, source.studyId),
            status: "draft",
            name: source.name,
            description: source.description,
            welcomeContent: source.welcomeContent,
            informationContent: source.informationContent,
            instructionContent: source.instructionContent,
            debriefContent: source.debriefContent,
            translationsJson: source.translationsJson,
            consentVersionId: source.consentVersionId,
            backgroundQuestionnaireVersionId: source.backgroundQuestionnaireVersionId,
            postQuestionnaireVersionId: source.postQuestionnaireVersionId,
            postReviewQuestionnaireVersionId: source.postReviewQuestionnaireVersionId,
            orderConfigJson: source.orderConfigJson,
            clonedFromProtocolVersionId: source.id,
            createdByLabel: ctx.actorLabel,
          })
          .returning(),
      );
      const sourceTasks = await tx
        .select()
        .from(protocolTasks)
        .where(eq(protocolTasks.protocolVersionId, source.id))
        .orderBy(asc(protocolTasks.orderIndex));
      for (const task of sourceTasks) {
        const { id: sourceTaskId, createdAt: _createdAt, ...taskValues } = task;
        const copy = one(
          await tx
            .insert(protocolTasks)
            .values({ ...taskValues, protocolVersionId: draft.id })
            .returning({ id: protocolTasks.id }),
        );
        const followups = await tx
          .select()
          .from(protocolTaskFollowups)
          .where(eq(protocolTaskFollowups.protocolTaskId, sourceTaskId));
        if (followups.length > 0) {
          await tx.insert(protocolTaskFollowups).values(
            followups.map(({ id: _id, ...followupValues }) => ({
              ...followupValues,
              protocolTaskId: copy.id,
            })),
          );
        }
      }
      await recordAudit(tx, {
        action: "protocol.clone",
        entityType: "protocol_version",
        entityId: draft.id,
        before: { clonedFromProtocolVersionId: source.id, versionNumber: source.versionNumber },
        after: { versionNumber: draft.versionNumber, name: draft.name, taskCount: sourceTasks.length },
        actorLabel: ctx.actorLabel,
      });
      return draft.id;
    })
    .catch(conflictOnVersionNumber);
  return loadProtocolDetail(ctx.db, newId);
}

async function assertSelectableConsent(tx: DbOrTx, studyId: string, consentVersionId: string): Promise<void> {
  const [consent] = await tx.select().from(consentVersions).where(eq(consentVersions.id, consentVersionId));
  if (!consent || consent.studyId !== studyId) {
    throw new AppError("VALIDATION_ERROR", "The selected consent version does not exist in this study.");
  }
  if (consent.publishedAt === null) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Consent v${consent.versionNumber} is still a draft. Publish it before selecting it in a protocol.`,
    );
  }
}

async function assertSelectableQuestionnaire(
  tx: DbOrTx,
  studyId: string,
  questionnaireVersionId: string,
  key: string,
  label: string,
): Promise<void> {
  const [version] = await tx
    .select()
    .from(questionnaireVersions)
    .where(eq(questionnaireVersions.id, questionnaireVersionId));
  if (!version || version.studyId !== studyId) {
    throw new AppError("VALIDATION_ERROR", `The selected ${label} does not exist in this study.`);
  }
  if (version.key !== key) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The selected ${label} has the key "${version.key}". A questionnaire with the key "${key}" is required here.`,
    );
  }
  if (version.status !== "published") {
    throw new AppError(
      "VALIDATION_ERROR",
      `The selected ${label} (v${version.versionNumber}) is ${version.status}. Only a published version can be selected.`,
    );
  }
}

function normalizeOrderConfig(orderConfig: ProtocolOrderConfig): ProtocolOrderConfig {
  return {
    blocks: orderConfig.blocks.map((block) => ({
      key: block.key,
      ...(block.title ? { title: block.title } : {}),
      orderMode: block.orderMode,
    })),
  };
}

// Edits a draft. `expectedUpdatedAt` is the updated_at value the editor loaded;
// when it no longer matches, the save is refused with CONFLICT.
// One audit row is written per save, with the changed fields before and after.
export async function updateProtocolDraft(
  ctx: ServiceContext,
  id: string,
  changes: ProtocolDraftChanges & { expectedUpdatedAt?: string | Date },
): Promise<ProtocolDetail> {
  const { expectedUpdatedAt, orderConfig, translations, ...fields } = changes;
  await ctx.db.transaction(async (tx) => {
    const protocol = await loadDraftForEdit(tx, id, expectedUpdatedAt);

    if (fields.name !== undefined && !fields.name.trim()) {
      throw new AppError("VALIDATION_ERROR", "A protocol needs a name.");
    }
    if (fields.consentVersionId) {
      await assertSelectableConsent(tx, protocol.studyId, fields.consentVersionId);
    }
    if (fields.backgroundQuestionnaireVersionId) {
      await assertSelectableQuestionnaire(
        tx,
        protocol.studyId,
        fields.backgroundQuestionnaireVersionId,
        protocolSchemas.BACKGROUND_QUESTIONNAIRE_KEY,
        "background questionnaire",
      );
    }
    if (fields.postQuestionnaireVersionId) {
      await assertSelectableQuestionnaire(
        tx,
        protocol.studyId,
        fields.postQuestionnaireVersionId,
        protocolSchemas.POST_QUESTIONNAIRE_KEY,
        "post-recording questionnaire",
      );
    }
    if (fields.postReviewQuestionnaireVersionId) {
      await assertSelectableQuestionnaire(
        tx,
        protocol.studyId,
        fields.postReviewQuestionnaireVersionId,
        protocolSchemas.POST_REVIEW_QUESTIONNAIRE_KEY,
        "post-review questionnaire",
      );
    }

    const next: Partial<ProtocolVersionRow> = { ...fields };
    if (fields.name !== undefined) next.name = fields.name.trim();
    if (translations !== undefined) next.translationsJson = compactTranslations(translations);
    if (orderConfig !== undefined) {
      const normalized = normalizeOrderConfig(orderConfig);
      const keys = normalized.blocks.map((block) => block.key);
      if (new Set(keys).size !== keys.length) {
        throw new AppError("VALIDATION_ERROR", "Block keys must be unique.");
      }
      const tasks = await tx
        .select({ blockKey: protocolTasks.blockKey })
        .from(protocolTasks)
        .where(eq(protocolTasks.protocolVersionId, id));
      const orphaned = [...new Set(tasks.map((task) => task.blockKey))].filter((key) => !keys.includes(key));
      const previousKeys = protocol.orderConfigJson.blocks.map((block) => block.key);
      const removedWithTasks = orphaned.filter((key) => previousKeys.includes(key));
      if (removedWithTasks.length > 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          `The block "${removedWithTasks[0]}" still has tasks. Move or delete its tasks before removing the block.`,
          { blockKeys: removedWithTasks },
        );
      }
      next.orderConfigJson = normalized;
    }

    const diff = changedFields(protocol, next);
    if (diff.keys.length === 0) return;
    await tx
      .update(protocolVersions)
      .set(diff.after)
      .where(eq(protocolVersions.id, id));
    if (next.orderConfigJson !== undefined && diff.keys.includes("orderConfigJson")) {
      // Block order and block order mode decide the task order and each task's order mode.
      await renumberTasks(tx, id, next.orderConfigJson);
    }
    await recordAudit(tx, {
      action: "protocol.update_draft",
      entityType: "protocol_version",
      entityId: id,
      before: diff.before,
      after: diff.after,
      actorLabel: ctx.actorLabel,
    });
  });
  return loadProtocolDetail(ctx.db, id);
}

// Retires a published version that is no longer the current one. Sessions that
// used it stay pinned to it and remain readable.
export async function retireProtocol(ctx: ServiceContext, id: string): Promise<ProtocolDetail> {
  await ctx.db.transaction(async (tx) => {
    const found = await loadProtocol(tx, id);
    const study = await lockStudy(tx, found.studyId);
    const protocol = await loadProtocol(tx, id, { lock: true });
    if (protocol.status === "draft") {
      throw new AppError("INVALID_STATE", `${protocolLabel(protocol)} is a draft. Only a published version can be retired.`);
    }
    if (protocol.status === "retired") {
      throw new AppError("INVALID_STATE", `${protocolLabel(protocol)} is already retired.`);
    }
    if (study.currentProtocolVersionId === protocol.id) {
      throw new AppError(
        "INVALID_STATE",
        `${protocolLabel(protocol)} is the current protocol for new sessions. Publish another version before retiring it.`,
      );
    }
    const retiredAt = ctx.now();
    await tx.update(protocolVersions).set({ status: "retired", retiredAt }).where(eq(protocolVersions.id, id));
    await recordAudit(tx, {
      action: "protocol.retire",
      entityType: "protocol_version",
      entityId: id,
      before: { status: "published" },
      after: { status: "retired", retiredAt: retiredAt.toISOString(), versionNumber: protocol.versionNumber },
      actorLabel: ctx.actorLabel,
    });
  });
  return loadProtocolDetail(ctx.db, id);
}

// Deletes a draft with its tasks and follow-ups (cascade). A published or
// retired version is never deleted.
export async function deleteProtocolDraft(
  ctx: ServiceContext,
  id: string,
): Promise<{ deleted: true; id: string; versionNumber: number }> {
  return ctx.db.transaction(async (tx) => {
    const protocol = await loadProtocol(tx, id, { lock: true });
    if (protocol.status !== "draft") {
      throw new AppError(
        "IMMUTABLE_RECORD",
        `${protocolLabel(protocol)} is ${protocol.status} and cannot be deleted. Only a draft can be deleted.`,
        { protocolVersionId: protocol.id, status: protocol.status },
      );
    }
    // Deleting the draft would clear cloned_from_protocol_version_id on the
    // versions cloned from it. For a published or retired version that is a
    // change to an immutable row, which the database refuses.
    const clones = await tx
      .select({ versionNumber: protocolVersions.versionNumber })
      .from(protocolVersions)
      .where(and(eq(protocolVersions.clonedFromProtocolVersionId, id), ne(protocolVersions.status, "draft")));
    if (clones.length > 0) {
      const numbers = clones.map((clone) => `v${clone.versionNumber}`).join(", ");
      throw new AppError(
        "CONFLICT",
        `${protocolLabel(protocol)} cannot be deleted because a published or retired version (${numbers}) records that it was cloned from this draft. That record is immutable. Publish or keep this draft instead.`,
        { clonedVersionNumbers: clones.map((clone) => clone.versionNumber) },
      );
    }
    const [tasks] = await tx
      .select({ n: count() })
      .from(protocolTasks)
      .where(eq(protocolTasks.protocolVersionId, id));
    await tx.delete(protocolVersions).where(eq(protocolVersions.id, id));
    await recordAudit(tx, {
      action: "protocol.delete_draft",
      entityType: "protocol_version",
      entityId: id,
      before: { versionNumber: protocol.versionNumber, name: protocol.name, taskCount: tasks?.n ?? 0 },
      actorLabel: ctx.actorLabel,
    });
    return { deleted: true as const, id, versionNumber: protocol.versionNumber };
  });
}
