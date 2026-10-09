// Flags and notes on utterances and transcripts for the review screen
// (spec 66, 71, 88). They use the generic tables research_flags and research_notes.
//
// A flag asks for attention. It is not an exclusion and it changes no data.
// Resolving a flag sets resolved_at; the row stays. Notes are internal and are
// never shown to participants.
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { researchFlags, researchNotes, transcripts, utterances, type DbOrTx } from "@dialect/db";
import { AppError, FLAG_REASON_CODES, transcriptSchemas, type TranscriptType } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { parseInput, resolveLabel, toIso } from "./shared";

const { MAX_LABEL_LENGTH, MAX_NOTE_LENGTH, REVIEW_ENTITY_TYPES } = transcriptSchemas;

type FlagRow = typeof researchFlags.$inferSelect;
type NoteRow = typeof researchNotes.$inferSelect;

const optionalNotes = z
  .string()
  .trim()
  .max(MAX_NOTE_LENGTH)
  .transform((value) => (value === "" ? undefined : value))
  .nullish();
const optionalLabel = z.string().trim().min(1).max(MAX_LABEL_LENGTH).optional();

const addFlagInputSchema = z.object({
  entityType: z.enum(REVIEW_ENTITY_TYPES),
  entityId: z.uuid(),
  reasonCode: z.enum(FLAG_REASON_CODES),
  notes: optionalNotes,
  annotatorLabel: optionalLabel,
  // When given, a transcript entity must belong to this utterance.
  utteranceId: z.uuid().optional(),
});
export type AddFlagInput = z.input<typeof addFlagInputSchema>;

const resolveFlagInputSchema = z.object({ flagId: z.uuid(), annotatorLabel: optionalLabel });
export type ResolveFlagInput = z.input<typeof resolveFlagInputSchema>;

const addNoteInputSchema = z.object({
  entityType: z.enum(REVIEW_ENTITY_TYPES),
  entityId: z.uuid(),
  body: z.string().trim().min(1).max(MAX_NOTE_LENGTH),
  annotatorLabel: optionalLabel,
  utteranceId: z.uuid().optional(),
});
export type AddNoteInput = z.input<typeof addNoteInputSchema>;

// Checks that the flagged or annotated entity exists. Returns the transcript
// type when the entity is a transcript.
async function assertEntity(
  db: DbOrTx,
  entity: { entityType: transcriptSchemas.ReviewEntityType; entityId: string; utteranceId?: string },
): Promise<TranscriptType | null> {
  if (entity.entityType === "utterance") {
    if (entity.utteranceId !== undefined && entity.utteranceId !== entity.entityId) {
      throw new AppError("VALIDATION_ERROR", "The entity is not the utterance of this request.");
    }
    const [row] = await db.select({ id: utterances.id }).from(utterances).where(eq(utterances.id, entity.entityId));
    if (!row) throw new AppError("NOT_FOUND", "The utterance does not exist.");
    return null;
  }
  const [row] = await db
    .select({ type: transcripts.type, utteranceId: transcripts.utteranceId })
    .from(transcripts)
    .where(eq(transcripts.id, entity.entityId));
  if (!row) throw new AppError("NOT_FOUND", "The transcript does not exist.");
  if (entity.utteranceId !== undefined && row.utteranceId !== entity.utteranceId) {
    throw new AppError("VALIDATION_ERROR", "The transcript does not belong to this utterance.");
  }
  return row.type;
}

function toFlagView(row: FlagRow, transcriptType: TranscriptType | null): transcriptSchemas.ReviewFlagView {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    transcriptType,
    reasonCode: row.reasonCode,
    notes: row.notes,
    createdByLabel: row.createdByLabel,
    createdAt: toIso(row.createdAt),
    resolvedAt: toIso(row.resolvedAt),
  };
}

function toNoteView(row: NoteRow, transcriptType: TranscriptType | null): transcriptSchemas.ReviewNoteView {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    transcriptType,
    body: row.body,
    createdByLabel: row.createdByLabel,
    createdAt: toIso(row.createdAt),
  };
}

// Adds a flag with a reason code to an utterance or a transcript.
export async function addFlag(ctx: ServiceContext, input: AddFlagInput): Promise<transcriptSchemas.AddFlagResponse> {
  const parsed = parseInput(addFlagInputSchema, input);
  const createdByLabel = resolveLabel(ctx, parsed.annotatorLabel);
  return ctx.db.transaction(async (tx) => {
    const transcriptType = await assertEntity(tx, parsed);
    const [row] = await tx
      .insert(researchFlags)
      .values({
        entityType: parsed.entityType,
        entityId: parsed.entityId,
        reasonCode: parsed.reasonCode,
        notes: parsed.notes ?? null,
        createdByLabel,
        createdAt: ctx.now(),
      })
      .returning();
    if (!row) throw new AppError("INTERNAL_ERROR", "The flag could not be stored.");
    await recordAudit(tx, {
      action: "flag.create",
      entityType: parsed.entityType,
      entityId: parsed.entityId,
      after: { flagId: row.id, reasonCode: row.reasonCode },
      actorLabel: createdByLabel,
    });
    return { flag: toFlagView(row, transcriptType) };
  });
}

// Marks a flag on an utterance or a transcript as resolved. Resolving twice changes nothing.
export async function resolveFlag(
  ctx: ServiceContext,
  input: ResolveFlagInput,
): Promise<transcriptSchemas.ResolveFlagResponse> {
  const parsed = parseInput(resolveFlagInputSchema, input);
  return ctx.db.transaction(async (tx) => {
    const [flag] = await tx.select().from(researchFlags).where(eq(researchFlags.id, parsed.flagId)).for("update");
    const isReviewEntity = flag && (REVIEW_ENTITY_TYPES as readonly string[]).includes(flag.entityType);
    // Flags on other entities (sessions, outputs) belong to other services.
    if (!flag || !isReviewEntity) throw new AppError("NOT_FOUND", "The flag does not exist.");
    const transcriptType =
      flag.entityType === "transcript"
        ? ((await tx.select({ type: transcripts.type }).from(transcripts).where(eq(transcripts.id, flag.entityId)))[0]
            ?.type ?? null)
        : null;
    if (flag.resolvedAt !== null) return { flag: toFlagView(flag, transcriptType) };

    const [row] = await tx
      .update(researchFlags)
      .set({ resolvedAt: ctx.now() })
      .where(eq(researchFlags.id, flag.id))
      .returning();
    if (!row) throw new AppError("INTERNAL_ERROR", "The flag could not be updated.");
    await recordAudit(tx, {
      action: "flag.resolve",
      entityType: flag.entityType as transcriptSchemas.ReviewEntityType,
      entityId: flag.entityId,
      before: { flagId: flag.id, resolvedAt: null },
      after: { flagId: flag.id, resolvedAt: toIso(row.resolvedAt) },
      actorLabel: resolveLabel(ctx, parsed.annotatorLabel),
    });
    return { flag: toFlagView(row, transcriptType) };
  });
}

// Adds an internal researcher note to an utterance or a transcript.
export async function addNote(ctx: ServiceContext, input: AddNoteInput): Promise<transcriptSchemas.AddNoteResponse> {
  const parsed = parseInput(addNoteInputSchema, input);
  const createdByLabel = resolveLabel(ctx, parsed.annotatorLabel);
  return ctx.db.transaction(async (tx) => {
    const transcriptType = await assertEntity(tx, parsed);
    const [row] = await tx
      .insert(researchNotes)
      .values({
        entityType: parsed.entityType,
        entityId: parsed.entityId,
        body: parsed.body,
        createdByLabel,
        createdAt: ctx.now(),
      })
      .returning();
    if (!row) throw new AppError("INTERNAL_ERROR", "The note could not be stored.");
    // The note text is not copied into the audit log.
    await recordAudit(tx, {
      action: "note.create",
      entityType: parsed.entityType,
      entityId: parsed.entityId,
      after: { noteId: row.id },
      actorLabel: createdByLabel,
    });
    return { note: toNoteView(row, transcriptType) };
  });
}

// Flags (open and resolved) and notes of one utterance and its transcripts, newest first.
export async function listFlagsAndNotes(
  db: DbOrTx,
  utteranceId: string,
  utteranceTranscripts: { id: string; type: TranscriptType }[],
): Promise<{ flags: transcriptSchemas.ReviewFlagView[]; notes: transcriptSchemas.ReviewNoteView[] }> {
  const transcriptIds = utteranceTranscripts.map((transcript) => transcript.id);
  const typeOf = (entityType: string, entityId: string): TranscriptType | null =>
    entityType === "transcript" ? (utteranceTranscripts.find((t) => t.id === entityId)?.type ?? null) : null;

  const flagRows = await db
    .select()
    .from(researchFlags)
    .where(
      or(
        and(eq(researchFlags.entityType, "utterance"), eq(researchFlags.entityId, utteranceId)),
        transcriptIds.length > 0
          ? and(eq(researchFlags.entityType, "transcript"), inArray(researchFlags.entityId, transcriptIds))
          : undefined,
      ),
    )
    .orderBy(desc(researchFlags.createdAt), desc(researchFlags.id));
  const noteRows = await db
    .select()
    .from(researchNotes)
    .where(
      or(
        and(eq(researchNotes.entityType, "utterance"), eq(researchNotes.entityId, utteranceId)),
        transcriptIds.length > 0
          ? and(eq(researchNotes.entityType, "transcript"), inArray(researchNotes.entityId, transcriptIds))
          : undefined,
      ),
    )
    .orderBy(desc(researchNotes.createdAt), desc(researchNotes.id));

  return {
    flags: flagRows.map((row) => toFlagView(row, typeOf(row.entityType, row.entityId))),
    notes: noteRows.map((row) => toNoteView(row, typeOf(row.entityType, row.entityId))),
  };
}
