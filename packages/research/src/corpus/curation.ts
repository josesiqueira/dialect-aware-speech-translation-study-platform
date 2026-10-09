// Flags, exclusion, notes and output status (spec 66, 70, 71, 88, 116).
//
// The three are different things:
//   flag       asks for attention. It changes no data and excludes nothing.
//   exclusion  keeps every row and file, and removes the session or utterance
//              from analysis exports by default.
//   deletion   is the separate audited media workflow in media.ts.
// Nothing in this file deletes a row or a file.
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  mediaAssets,
  researchFlags,
  researchNotes,
  sessions,
  syntheses,
  translations,
  utterances,
  type Transaction,
} from "@dialect/db";
import { AppError, FLAG_REASON_CODES, OUTPUT_STATUSES, corpusSchemas, type OutputStatus } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { parseInput, toIso } from "./shared";

const notes = z
  .string()
  .trim()
  .max(corpusSchemas.MAX_NOTE_LENGTH)
  .transform((value) => (value === "" ? null : value))
  .nullish();
const reason = z.string().trim().min(1, "a reason is required").max(corpusSchemas.MAX_REASON_LENGTH);
const reasonCode = z.enum(FLAG_REASON_CODES).optional();

const sessionFlagSchema = z.object({ sessionId: z.uuid(), flagged: z.boolean(), notes, reasonCode });
export type SetSessionFlagInput = z.input<typeof sessionFlagSchema>;

const utteranceFlagSchema = z.object({
  utteranceId: z.uuid(),
  // When given, the utterance must belong to this session.
  sessionId: z.uuid().optional(),
  flagged: z.boolean(),
  notes,
  reasonCode,
});
export type SetUtteranceFlagInput = z.input<typeof utteranceFlagSchema>;

const excludeSessionSchema = z.object({ sessionId: z.uuid(), reason });
export type ExcludeSessionInput = z.input<typeof excludeSessionSchema>;
const includeSessionSchema = z.object({ sessionId: z.uuid() });
export type IncludeSessionInput = z.input<typeof includeSessionSchema>;

const excludeUtteranceSchema = z.object({ utteranceId: z.uuid(), sessionId: z.uuid().optional(), reason });
export type ExcludeUtteranceInput = z.input<typeof excludeUtteranceSchema>;
const includeUtteranceSchema = z.object({ utteranceId: z.uuid(), sessionId: z.uuid().optional() });
export type IncludeUtteranceInput = z.input<typeof includeUtteranceSchema>;

const addNoteSchema = z.object({
  entityType: z.enum(corpusSchemas.NOTE_ENTITY_TYPES),
  entityId: z.uuid(),
  body: z.string().trim().min(1, "the note is empty").max(corpusSchemas.MAX_NOTE_LENGTH),
  // When given, an utterance must belong to this session, and a session id must equal it.
  sessionId: z.uuid().optional(),
});
export type AddNoteInput = z.input<typeof addNoteSchema>;

const outputStatusSchema = z.object({
  entityType: z.enum(corpusSchemas.OUTPUT_ENTITY_TYPES),
  entityId: z.uuid(),
  status: z.enum(OUTPUT_STATUSES),
  reasonCode,
  notes,
});
export type SetOutputStatusInput = z.input<typeof outputStatusSchema>;

export type FlagState = { id: string; flagged: boolean; flagNotes: string | null };
export type SessionExclusionState = { id: string; excluded: boolean; exclusionReason: string | null };
export type UtteranceExclusionState = {
  id: string;
  status: (typeof utterances.$inferSelect)["status"];
  exclusionReason: string | null;
};
export type OutputStatusState = { entityType: corpusSchemas.OutputEntityType; id: string; status: OutputStatus };

// Keeps the flag history in research_flags in step with the boolean on the row.
// Setting a flag opens a row (or updates the open one, so editing the notes does
// not add a row per edit). Clearing the flag resolves every open row of the entity.
async function syncFlagHistory(
  tx: Transaction,
  ctx: ServiceContext,
  entity: { entityType: "session" | "utterance"; entityId: string },
  change: { flagged: boolean; wasFlagged: boolean; notes: string | null; reasonCode: string | undefined },
): Promise<void> {
  const open = and(
    eq(researchFlags.entityType, entity.entityType),
    eq(researchFlags.entityId, entity.entityId),
    isNull(researchFlags.resolvedAt),
  );
  if (!change.flagged) {
    await tx.update(researchFlags).set({ resolvedAt: ctx.now() }).where(open);
    return;
  }
  const [latest] = change.wasFlagged
    ? await tx.select().from(researchFlags).where(open).orderBy(desc(researchFlags.createdAt)).limit(1)
    : [];
  if (latest) {
    await tx
      .update(researchFlags)
      .set({ notes: change.notes, reasonCode: change.reasonCode ?? latest.reasonCode })
      .where(eq(researchFlags.id, latest.id));
    return;
  }
  await tx.insert(researchFlags).values({
    entityType: entity.entityType,
    entityId: entity.entityId,
    reasonCode: change.reasonCode ?? "other",
    notes: change.notes,
    createdByLabel: ctx.actorLabel,
    createdAt: ctx.now(),
  });
}

async function lockUtterance(tx: Transaction, utteranceId: string, sessionId: string | undefined) {
  const [row] = await tx.select().from(utterances).where(eq(utterances.id, utteranceId)).for("update");
  if (!row || (sessionId !== undefined && row.sessionId !== sessionId)) {
    throw new AppError("NOT_FOUND", "The utterance does not exist.", { utteranceId });
  }
  return row;
}

async function lockSession(tx: Transaction, sessionId: string) {
  const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
  if (!row) throw new AppError("NOT_FOUND", "The session does not exist.", { sessionId });
  return row;
}

// Sets or clears the review flag of a session. A flag is not an exclusion.
export async function setSessionFlag(ctx: ServiceContext, input: SetSessionFlagInput): Promise<FlagState> {
  const parsed = parseInput(sessionFlagSchema, input);
  return ctx.db.transaction(async (tx) => {
    const session = await lockSession(tx, parsed.sessionId);
    const flagNotes = parsed.flagged ? (parsed.notes ?? null) : null;
    if (session.flagged === parsed.flagged && session.flagNotes === flagNotes && !parsed.reasonCode) {
      return { id: session.id, flagged: session.flagged, flagNotes: session.flagNotes };
    }
    await tx.update(sessions).set({ flagged: parsed.flagged, flagNotes }).where(eq(sessions.id, session.id));
    await syncFlagHistory(tx, ctx, { entityType: "session", entityId: session.id }, {
      flagged: parsed.flagged,
      wasFlagged: session.flagged,
      notes: flagNotes,
      reasonCode: parsed.reasonCode,
    });
    // The note text is not copied into the audit log.
    await recordAudit(tx, {
      action: parsed.flagged ? "session.flag" : "session.unflag",
      entityType: "session",
      entityId: session.id,
      before: { flagged: session.flagged, hasNotes: session.flagNotes !== null },
      after: { flagged: parsed.flagged, hasNotes: flagNotes !== null, reasonCode: parsed.reasonCode ?? null },
      actorLabel: ctx.actorLabel,
    });
    return { id: session.id, flagged: parsed.flagged, flagNotes };
  });
}

// Sets or clears the review flag of an utterance. A flag is not an exclusion.
export async function setUtteranceFlag(ctx: ServiceContext, input: SetUtteranceFlagInput): Promise<FlagState> {
  const parsed = parseInput(utteranceFlagSchema, input);
  return ctx.db.transaction(async (tx) => {
    const utterance = await lockUtterance(tx, parsed.utteranceId, parsed.sessionId);
    const flagNotes = parsed.flagged ? (parsed.notes ?? null) : null;
    if (utterance.flagged === parsed.flagged && utterance.flagNotes === flagNotes && !parsed.reasonCode) {
      return { id: utterance.id, flagged: utterance.flagged, flagNotes: utterance.flagNotes };
    }
    await tx.update(utterances).set({ flagged: parsed.flagged, flagNotes }).where(eq(utterances.id, utterance.id));
    await syncFlagHistory(tx, ctx, { entityType: "utterance", entityId: utterance.id }, {
      flagged: parsed.flagged,
      wasFlagged: utterance.flagged,
      notes: flagNotes,
      reasonCode: parsed.reasonCode,
    });
    await recordAudit(tx, {
      action: parsed.flagged ? "utterance.flag" : "utterance.unflag",
      entityType: "utterance",
      entityId: utterance.id,
      before: { flagged: utterance.flagged, hasNotes: utterance.flagNotes !== null },
      after: { flagged: parsed.flagged, hasNotes: flagNotes !== null, reasonCode: parsed.reasonCode ?? null },
      actorLabel: ctx.actorLabel,
    });
    return { id: utterance.id, flagged: parsed.flagged, flagNotes };
  });
}

// Excludes a whole session from analysis. Every row and file is kept (spec 70).
export async function excludeSession(ctx: ServiceContext, input: ExcludeSessionInput): Promise<SessionExclusionState> {
  const parsed = parseInput(excludeSessionSchema, input);
  return ctx.db.transaction(async (tx) => {
    const session = await lockSession(tx, parsed.sessionId);
    if (session.excluded && session.exclusionReason === parsed.reason) {
      return { id: session.id, excluded: true, exclusionReason: session.exclusionReason };
    }
    await tx
      .update(sessions)
      .set({ excluded: true, exclusionReason: parsed.reason })
      .where(eq(sessions.id, session.id));
    await recordAudit(tx, {
      action: "session.exclude",
      entityType: "session",
      entityId: session.id,
      before: { excluded: session.excluded, exclusionReason: session.exclusionReason },
      after: { excluded: true, exclusionReason: parsed.reason },
      actorLabel: ctx.actorLabel,
    });
    return { id: session.id, excluded: true, exclusionReason: parsed.reason };
  });
}

// Takes a session back into analysis.
export async function includeSession(ctx: ServiceContext, input: IncludeSessionInput): Promise<SessionExclusionState> {
  const parsed = parseInput(includeSessionSchema, input);
  return ctx.db.transaction(async (tx) => {
    const session = await lockSession(tx, parsed.sessionId);
    if (!session.excluded) return { id: session.id, excluded: false, exclusionReason: null };
    await tx.update(sessions).set({ excluded: false, exclusionReason: null }).where(eq(sessions.id, session.id));
    await recordAudit(tx, {
      action: "session.include",
      entityType: "session",
      entityId: session.id,
      before: { excluded: true, exclusionReason: session.exclusionReason },
      after: { excluded: false, exclusionReason: null },
      actorLabel: ctx.actorLabel,
    });
    return { id: session.id, excluded: false, exclusionReason: null };
  });
}

// Excludes one utterance from analysis: status "excluded" with a reason. The
// recording, transcripts and outputs are kept.
export async function excludeUtterance(
  ctx: ServiceContext,
  input: ExcludeUtteranceInput,
): Promise<UtteranceExclusionState> {
  const parsed = parseInput(excludeUtteranceSchema, input);
  return ctx.db.transaction(async (tx) => {
    const utterance = await lockUtterance(tx, parsed.utteranceId, parsed.sessionId);
    if (utterance.status !== "submitted" && utterance.status !== "excluded") {
      throw new AppError(
        "INVALID_STATE",
        `Only a submitted utterance can be excluded. This utterance has the status "${utterance.status}".`,
        { status: utterance.status },
      );
    }
    if (utterance.status === "excluded" && utterance.exclusionReason === parsed.reason) {
      return { id: utterance.id, status: utterance.status, exclusionReason: utterance.exclusionReason };
    }
    await tx
      .update(utterances)
      .set({ status: "excluded", exclusionReason: parsed.reason })
      .where(eq(utterances.id, utterance.id));
    await recordAudit(tx, {
      action: "utterance.exclude",
      entityType: "utterance",
      entityId: utterance.id,
      before: { status: utterance.status, exclusionReason: utterance.exclusionReason },
      after: { status: "excluded", exclusionReason: parsed.reason },
      actorLabel: ctx.actorLabel,
    });
    return { id: utterance.id, status: "excluded", exclusionReason: parsed.reason };
  });
}

// Takes an excluded utterance back into analysis (status "submitted").
export async function includeUtterance(
  ctx: ServiceContext,
  input: IncludeUtteranceInput,
): Promise<UtteranceExclusionState> {
  const parsed = parseInput(includeUtteranceSchema, input);
  return ctx.db.transaction(async (tx) => {
    const utterance = await lockUtterance(tx, parsed.utteranceId, parsed.sessionId);
    if (utterance.status === "submitted") {
      return { id: utterance.id, status: utterance.status, exclusionReason: utterance.exclusionReason };
    }
    if (utterance.status !== "excluded") {
      throw new AppError(
        "INVALID_STATE",
        `Only an excluded utterance can be included again. This utterance has the status "${utterance.status}".`,
        { status: utterance.status },
      );
    }
    if (utterance.acceptedMediaAssetId) {
      const [asset] = await tx
        .select({ deletedAt: mediaAssets.deletedAt })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, utterance.acceptedMediaAssetId));
      if (asset?.deletedAt) {
        throw new AppError(
          "INVALID_STATE",
          "The source recording of this utterance was deleted, so the utterance cannot be included in analysis again.",
        );
      }
    }
    await tx
      .update(utterances)
      .set({ status: "submitted", exclusionReason: null })
      .where(eq(utterances.id, utterance.id));
    await recordAudit(tx, {
      action: "utterance.include",
      entityType: "utterance",
      entityId: utterance.id,
      before: { status: "excluded", exclusionReason: utterance.exclusionReason },
      after: { status: "submitted", exclusionReason: null },
      actorLabel: ctx.actorLabel,
    });
    return { id: utterance.id, status: "submitted", exclusionReason: null };
  });
}

// Adds an internal researcher note to a session, utterance, translation or synthesis.
export async function addNote(ctx: ServiceContext, input: AddNoteInput): Promise<corpusSchemas.NoteView> {
  const parsed = parseInput(addNoteSchema, input);
  return ctx.db.transaction(async (tx) => {
    if (parsed.entityType === "session") {
      if (parsed.sessionId !== undefined && parsed.sessionId !== parsed.entityId) {
        throw new AppError("VALIDATION_ERROR", "The note is not for the session of this request.");
      }
      const [row] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, parsed.entityId));
      if (!row) throw new AppError("NOT_FOUND", "The session does not exist.");
    } else if (parsed.entityType === "utterance") {
      const [row] = await tx
        .select({ sessionId: utterances.sessionId })
        .from(utterances)
        .where(eq(utterances.id, parsed.entityId));
      if (!row || (parsed.sessionId !== undefined && row.sessionId !== parsed.sessionId)) {
        throw new AppError("NOT_FOUND", "The utterance does not exist.");
      }
    } else if (parsed.entityType === "translation") {
      const [row] = await tx.select({ id: translations.id }).from(translations).where(eq(translations.id, parsed.entityId));
      if (!row) throw new AppError("NOT_FOUND", "The translation does not exist.");
    } else {
      const [row] = await tx.select({ id: syntheses.id }).from(syntheses).where(eq(syntheses.id, parsed.entityId));
      if (!row) throw new AppError("NOT_FOUND", "The synthesis does not exist.");
    }

    const [note] = await tx
      .insert(researchNotes)
      .values({
        entityType: parsed.entityType,
        entityId: parsed.entityId,
        body: parsed.body,
        createdByLabel: ctx.actorLabel,
        createdAt: ctx.now(),
      })
      .returning();
    if (!note) throw new AppError("INTERNAL_ERROR", "The note could not be stored.");
    // The note text is not copied into the audit log.
    await recordAudit(tx, {
      action: "note.create",
      entityType: parsed.entityType,
      entityId: parsed.entityId,
      after: { noteId: note.id },
      actorLabel: ctx.actorLabel,
    });
    return {
      id: note.id,
      entityType: note.entityType,
      entityId: note.entityId,
      body: note.body,
      createdByLabel: note.createdByLabel,
      createdAt: toIso(note.createdAt),
    };
  });
}

// Changes the status of a translation or synthesis: "reviewed", "excluded" or
// back to "generated". The status is the only column of these rows that can
// change; the text, the audio and the provenance are immutable. A reason code or
// notes are stored as a flag row for the output.
export async function setOutputStatus(ctx: ServiceContext, input: SetOutputStatusInput): Promise<OutputStatusState> {
  const parsed = parseInput(outputStatusSchema, input);
  return ctx.db.transaction(async (tx) => {
    const table = parsed.entityType === "translation" ? translations : syntheses;
    const [row] = await tx.select({ id: table.id, status: table.status }).from(table).where(eq(table.id, parsed.entityId)).for("update");
    if (!row) throw new AppError("NOT_FOUND", `The ${parsed.entityType} does not exist.`, { id: parsed.entityId });

    const hasFlagDetails = parsed.reasonCode !== undefined || (parsed.notes ?? null) !== null;
    if (row.status === parsed.status && !hasFlagDetails) {
      return { entityType: parsed.entityType, id: row.id, status: row.status };
    }
    if (row.status !== parsed.status) {
      await tx.update(table).set({ status: parsed.status }).where(eq(table.id, row.id));
    }

    const open = and(
      eq(researchFlags.entityType, parsed.entityType),
      eq(researchFlags.entityId, row.id),
      isNull(researchFlags.resolvedAt),
    );
    let flagId: string | null = null;
    if (parsed.status === "generated") {
      await tx.update(researchFlags).set({ resolvedAt: ctx.now() }).where(open);
    } else if (hasFlagDetails) {
      const [flag] = await tx
        .insert(researchFlags)
        .values({
          entityType: parsed.entityType,
          entityId: row.id,
          reasonCode: parsed.reasonCode ?? "other",
          notes: parsed.notes ?? null,
          createdByLabel: ctx.actorLabel,
          createdAt: ctx.now(),
        })
        .returning({ id: researchFlags.id });
      flagId = flag?.id ?? null;
    }

    await recordAudit(tx, {
      action: "output.set_status",
      entityType: parsed.entityType,
      entityId: row.id,
      before: { status: row.status },
      after: { status: parsed.status, reasonCode: parsed.reasonCode ?? null, flagId },
      actorLabel: ctx.actorLabel,
    });
    return { entityType: parsed.entityType, id: row.id, status: parsed.status };
  });
}
