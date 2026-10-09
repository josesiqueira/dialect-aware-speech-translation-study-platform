// Consent versions (spec 6.2, 37.3, 76, 140): the information text, the privacy
// notice link, the contact details and the consent items.
//
// Rules kept here:
// - A consent version is a draft while published_at is empty. Once published
//   it never changes and cannot be deleted. To change the consent, clone the
//   published version, edit the draft and publish it as the next version.
// - A study has at most one consent draft at a time, like protocol drafts.
// - Every item has a stable id. The id is kept when a version is cloned, so
//   the answers of sessions under different consent versions can be compared.
//   An id must never be reused for a different meaning.
// - Publishing needs a title, an information text, at least one required item,
//   unique item ids and a text for every item.
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  consentVersions,
  getPgError,
  FOREIGN_KEY_VIOLATION_SQLSTATE,
  isUniqueViolation,
  protocolVersions,
  type ConsentItem,
  type DbOrTx,
} from "@dialect/db";
import { AppError, compactTranslations, type ConsentTranslations, type protocolSchemas } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { changedFields, lockStudy, one, type ConsentVersionRow } from "./shared";

export type ConsentVersionSummary = ConsentVersionRow & {
  status: "draft" | "published";
  // Version numbers of the protocol versions that select this consent version.
  usedByProtocolVersions: number[];
};

export type ConsentDraftInput = {
  studyId: string;
  title: string;
  informationText?: string;
  privacyNoticeUrl?: string | null;
  contactText?: string | null;
  items?: ConsentItem[];
  translations?: ConsentTranslations;
};

export type ConsentDraftChanges = protocolSchemas.ConsentDraftChanges;

function withStatus(row: ConsentVersionRow, usedBy: number[] = []): ConsentVersionSummary {
  return { ...row, status: row.publishedAt === null ? "draft" : "published", usedByProtocolVersions: usedBy };
}

function consentLabel(consent: { versionNumber: number }): string {
  return `Consent v${consent.versionNumber}`;
}

function normalizeItems(items: readonly ConsentItem[]): ConsentItem[] {
  const ids = items.map((item) => item.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new AppError("VALIDATION_ERROR", `The consent item id "${duplicate}" is used more than once.`);
  }
  return items.map((item) => ({
    id: item.id,
    text: item.text,
    required: item.required,
    ...(item.scope ? { scope: item.scope } : {}),
  }));
}

async function loadConsent(db: DbOrTx, id: string, options: { lock?: boolean } = {}): Promise<ConsentVersionRow> {
  const query = db.select().from(consentVersions).where(eq(consentVersions.id, id));
  const rows = options.lock ? await query.for("update") : await query;
  const consent = rows[0];
  if (!consent) throw new AppError("NOT_FOUND", "The consent version does not exist.");
  return consent;
}

function assertConsentDraft(consent: ConsentVersionRow): void {
  if (consent.publishedAt !== null) {
    throw new AppError(
      "IMMUTABLE_RECORD",
      `${consentLabel(consent)} is published and cannot be changed. Clone it to a new draft and edit the draft.`,
      { consentVersionId: consent.id },
    );
  }
}

async function usedBy(db: DbOrTx, studyId: string): Promise<Map<string, number[]>> {
  const rows = await db
    .select({ consentVersionId: protocolVersions.consentVersionId, versionNumber: protocolVersions.versionNumber })
    .from(protocolVersions)
    .where(eq(protocolVersions.studyId, studyId));
  const map = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.consentVersionId) continue;
    const list = map.get(row.consentVersionId) ?? [];
    list.push(row.versionNumber);
    map.set(row.consentVersionId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a - b);
  return map;
}

// Newest version first.
export async function listConsentVersions(ctx: ServiceContext, studyId: string): Promise<ConsentVersionSummary[]> {
  const rows = await ctx.db
    .select()
    .from(consentVersions)
    .where(eq(consentVersions.studyId, studyId))
    .orderBy(desc(consentVersions.versionNumber));
  const usage = await usedBy(ctx.db, studyId);
  return rows.map((row) => withStatus(row, usage.get(row.id) ?? []));
}

export async function getConsentVersion(ctx: ServiceContext, id: string): Promise<ConsentVersionSummary> {
  const consent = await loadConsent(ctx.db, id);
  const usage = await usedBy(ctx.db, consent.studyId);
  return withStatus(consent, usage.get(consent.id) ?? []);
}

async function nextVersionNumber(tx: DbOrTx, studyId: string): Promise<number> {
  const rows = await tx
    .select({ versionNumber: consentVersions.versionNumber })
    .from(consentVersions)
    .where(eq(consentVersions.studyId, studyId));
  return rows.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;
}

// Call with the study row locked.
async function assertNoOtherDraft(tx: DbOrTx, studyId: string): Promise<void> {
  const [draft] = await tx
    .select()
    .from(consentVersions)
    .where(and(eq(consentVersions.studyId, studyId), isNull(consentVersions.publishedAt)))
    .limit(1);
  if (draft) {
    throw new AppError(
      "CONFLICT",
      `A consent draft already exists: ${consentLabel(draft)} ("${draft.title}"). Edit that draft, or delete it before creating another one.`,
      { draftConsentVersionId: draft.id, versionNumber: draft.versionNumber },
    );
  }
}

function conflictOnVersionNumber(error: unknown): never {
  if (isUniqueViolation(error, "consent_versions_study_version_uq")) {
    throw new AppError("CONFLICT", "Another consent version was created at the same time. Try again.");
  }
  throw error;
}

async function insertDraft(
  ctx: ServiceContext,
  values: Omit<ConsentDraftInput, "items"> & { items: ConsentItem[] },
  clonedFrom: ConsentVersionRow | null,
): Promise<ConsentVersionSummary> {
  const title = values.title.trim();
  if (!title) throw new AppError("VALIDATION_ERROR", "A consent version needs a title.");
  return ctx.db
    .transaction(async (tx) => {
      await lockStudy(tx, values.studyId);
      await assertNoOtherDraft(tx, values.studyId);
      const consent = one(
        await tx
          .insert(consentVersions)
          .values({
            studyId: values.studyId,
            versionNumber: await nextVersionNumber(tx, values.studyId),
            title,
            informationText: values.informationText ?? "",
            privacyNoticeUrl: values.privacyNoticeUrl ?? null,
            contactText: values.contactText ?? null,
            itemsJson: normalizeItems(values.items),
            translationsJson: compactTranslations(values.translations),
            publishedAt: null,
            createdByLabel: ctx.actorLabel,
          })
          .returning(),
      );
      await recordAudit(tx, {
        action: clonedFrom ? "consent.clone" : "consent.create",
        entityType: "consent_version",
        entityId: consent.id,
        before: clonedFrom
          ? { clonedFromConsentVersionId: clonedFrom.id, versionNumber: clonedFrom.versionNumber }
          : null,
        after: {
          versionNumber: consent.versionNumber,
          title: consent.title,
          itemIds: consent.itemsJson.map((item) => item.id),
        },
        actorLabel: ctx.actorLabel,
      });
      return withStatus(consent);
    })
    .catch(conflictOnVersionNumber);
}

// A new consent draft with the next version number.
export async function createConsentDraft(
  ctx: ServiceContext,
  input: ConsentDraftInput,
): Promise<ConsentVersionSummary> {
  return insertDraft(ctx, { ...input, items: input.items ?? [] }, null);
}

// Copies a consent version into a new draft. Item ids are kept.
export async function cloneConsentVersion(ctx: ServiceContext, id: string): Promise<ConsentVersionSummary> {
  const source = await loadConsent(ctx.db, id);
  return insertDraft(
    ctx,
    {
      studyId: source.studyId,
      title: source.title,
      informationText: source.informationText,
      privacyNoticeUrl: source.privacyNoticeUrl,
      contactText: source.contactText,
      items: source.itemsJson,
      translations: source.translationsJson,
    },
    source,
  );
}

export async function updateConsentDraft(
  ctx: ServiceContext,
  id: string,
  changes: ConsentDraftChanges,
): Promise<ConsentVersionSummary> {
  return ctx.db.transaction(async (tx) => {
    const consent = await loadConsent(tx, id, { lock: true });
    assertConsentDraft(consent);
    const { items, translations, ...fields } = changes;
    const next: Partial<ConsentVersionRow> = { ...fields };
    if (translations !== undefined) next.translationsJson = compactTranslations(translations);
    if (fields.title !== undefined) {
      next.title = fields.title.trim();
      if (!next.title) throw new AppError("VALIDATION_ERROR", "A consent version needs a title.");
    }
    if (items !== undefined) next.itemsJson = normalizeItems(items);
    const diff = changedFields(consent, next);
    if (diff.keys.length === 0) return withStatus(consent);
    const updated = one(
      await tx.update(consentVersions).set(diff.after).where(eq(consentVersions.id, id)).returning(),
    );
    await recordAudit(tx, {
      action: "consent.update_draft",
      entityType: "consent_version",
      entityId: id,
      before: diff.before,
      after: diff.after,
      actorLabel: ctx.actorLabel,
    });
    return withStatus(updated);
  });
}

// The problems that block publishing a consent version.
export function consentPublishProblems(consent: ConsentVersionRow): string[] {
  const problems: string[] = [];
  if (!consent.title.trim()) problems.push("The title is empty.");
  if (!consent.informationText.trim()) problems.push("The information text is empty.");
  const items = consent.itemsJson ?? [];
  if (!items.some((item) => item.required)) {
    problems.push("At least one required consent item is needed.");
  }
  const ids = items.map((item) => item.id);
  const duplicate = ids.find((itemId, index) => ids.indexOf(itemId) !== index);
  if (duplicate !== undefined) problems.push(`The item id "${duplicate}" is used more than once.`);
  for (const item of items) {
    if (!item.id.trim()) problems.push("An item has no id.");
    if (!item.text.trim()) problems.push(`The item "${item.id}" has no text.`);
  }
  return problems;
}

// Sets published_at. From then on the version is immutable.
export async function publishConsentVersion(ctx: ServiceContext, id: string): Promise<ConsentVersionSummary> {
  return ctx.db.transaction(async (tx) => {
    const consent = await loadConsent(tx, id, { lock: true });
    if (consent.publishedAt !== null) {
      throw new AppError("INVALID_STATE", `${consentLabel(consent)} is already published.`);
    }
    const problems = consentPublishProblems(consent);
    if (problems.length > 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${consentLabel(consent)} cannot be published yet: ${problems.join(" ")}`,
        { problems },
      );
    }
    const publishedAt = ctx.now();
    const updated = one(
      await tx.update(consentVersions).set({ publishedAt }).where(eq(consentVersions.id, id)).returning(),
    );
    await recordAudit(tx, {
      action: "consent.publish",
      entityType: "consent_version",
      entityId: id,
      before: { publishedAt: null },
      after: {
        versionNumber: consent.versionNumber,
        publishedAt: publishedAt.toISOString(),
        itemIds: consent.itemsJson.map((item) => item.id),
      },
      actorLabel: ctx.actorLabel,
    });
    return withStatus(updated);
  });
}

// Deletes a consent draft. A published consent version is never deleted.
export async function deleteConsentDraft(
  ctx: ServiceContext,
  id: string,
): Promise<{ deleted: true; id: string; versionNumber: number }> {
  return ctx.db
    .transaction(async (tx) => {
      const consent = await loadConsent(tx, id, { lock: true });
      if (consent.publishedAt !== null) {
        throw new AppError(
          "IMMUTABLE_RECORD",
          `${consentLabel(consent)} is published and cannot be deleted. Only a draft can be deleted.`,
          { consentVersionId: consent.id },
        );
      }
      const [selectedBy] = await tx
        .select({ versionNumber: protocolVersions.versionNumber })
        .from(protocolVersions)
        .where(eq(protocolVersions.consentVersionId, id))
        .limit(1);
      if (selectedBy) {
        throw new AppError(
          "CONFLICT",
          `${consentLabel(consent)} is selected by Protocol v${selectedBy.versionNumber}. Select another consent version there first.`,
        );
      }
      await tx.delete(consentVersions).where(eq(consentVersions.id, id));
      await recordAudit(tx, {
        action: "consent.delete_draft",
        entityType: "consent_version",
        entityId: id,
        before: {
          versionNumber: consent.versionNumber,
          title: consent.title,
          itemIds: consent.itemsJson.map((item) => item.id),
        },
        after: { deleted: true },
        actorLabel: ctx.actorLabel,
      });
      return { deleted: true as const, id, versionNumber: consent.versionNumber };
    })
    .catch((error: unknown) => {
      if (getPgError(error)?.code === FOREIGN_KEY_VIOLATION_SQLSTATE) {
        throw new AppError("CONFLICT", "This consent version is still referred to and cannot be deleted.");
      }
      throw error;
    });
}
