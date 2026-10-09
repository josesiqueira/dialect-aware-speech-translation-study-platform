// Human transcript revisions and verification (spec 16, 17, 18, 127, 128).
//
// Rules enforced here (the database triggers are the safety net):
// - A researcher writes only A* (asr_corrected), B (human_dialect) and C (normalized).
//   ASR revisions are created only by the processing pipeline.
// - A revision is never edited. Every save with a changed text inserts a new
//   revision and moves is_current to it, in one transaction.
// - Saving the text of the current revision again writes nothing.
// - A verified transcript can only be changed with a change reason. The verified
//   revision stays in the history as it was.
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation, transcriptRevisions, transcripts, type Transaction } from "@dialect/db";
import { AppError, TRANSCRIPT_TYPE_LABELS, transcriptSchemas, type ReviewStatus } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import {
  buildTranscriptView,
  isHumanTranscriptType,
  loadTranscript,
  loadUtteranceScope,
  parseInput,
  resolveLabel,
  toRevisionView,
  type TranscriptRevisionRow,
  type TranscriptRow,
} from "./shared";

const {
  DERIVATION_SOURCE_TYPE,
  HUMAN_TRANSCRIPT_TYPES,
  saveRevisionBodySchema,
  setTranscriptStatusBodySchema,
  verifyTranscriptBodySchema,
} = transcriptSchemas;

const saveRevisionInputSchema = saveRevisionBodySchema.extend({
  utteranceId: z.uuid(),
  type: z.enum(HUMAN_TRANSCRIPT_TYPES, {
    error: "Only the transcripts A* (asr_corrected), B (human_dialect) and C (normalized) can be edited.",
  }),
});
export type SaveTranscriptRevisionInput = z.input<typeof saveRevisionInputSchema>;

const saveByTranscriptInputSchema = saveRevisionBodySchema.extend({ transcriptId: z.uuid() });
export type SaveRevisionForTranscriptInput = z.input<typeof saveByTranscriptInputSchema>;

const verifyInputSchema = verifyTranscriptBodySchema.extend({ transcriptId: z.uuid() });
export type VerifyTranscriptInput = z.input<typeof verifyInputSchema>;

const setStatusInputSchema = setTranscriptStatusBodySchema.extend({ transcriptId: z.uuid() });
export type SetTranscriptStatusInput = z.input<typeof setStatusInputSchema>;

const REVISION_UNIQUE_INDEXES = [
  "transcript_revisions_one_current_uq",
  "transcript_revisions_transcript_number_uq",
  "transcripts_utterance_type_uq",
];
const MAX_SAVE_ATTEMPTS = 3;

async function lockTranscript(tx: Transaction, transcriptId: string): Promise<TranscriptRow> {
  // The row lock makes concurrent saves and verifications of one transcript run one after another.
  const [row] = await tx.select().from(transcripts).where(eq(transcripts.id, transcriptId)).for("update");
  if (!row) throw new AppError("NOT_FOUND", "The transcript does not exist.");
  return row;
}

async function currentRevisionOf(tx: Transaction, transcriptId: string): Promise<TranscriptRevisionRow | null> {
  const [row] = await tx
    .select()
    .from(transcriptRevisions)
    .where(and(eq(transcriptRevisions.transcriptId, transcriptId), eq(transcriptRevisions.isCurrent, true)));
  return row ?? null;
}

// Saves the text of A*, B or C for one utterance as a new revision.
//
// Creates the transcript row when it does not exist yet. Returns created: false
// and writes nothing when the text equals the current revision.
export async function saveTranscriptRevision(
  ctx: ServiceContext,
  input: SaveTranscriptRevisionInput,
): Promise<transcriptSchemas.SaveRevisionResponse> {
  const parsed = parseInput(saveRevisionInputSchema, input);
  const derivationSource = DERIVATION_SOURCE_TYPE[parsed.type];
  if (parsed.derivedFromRevisionId && derivationSource === null) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The dialect-preserving transcript (B) is transcribed from the audio. It cannot be derived from another transcript.",
    );
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ctx.db.transaction(async (tx) => {
        const scope = await loadUtteranceScope(tx, parsed.utteranceId);
        if (scope.utteranceStatus !== "submitted" && scope.utteranceStatus !== "excluded") {
          throw new AppError("INVALID_STATE", "The utterance has no submitted recording to transcribe.");
        }

        await tx
          .insert(transcripts)
          .values({ utteranceId: parsed.utteranceId, type: parsed.type, status: "not_started" })
          .onConflictDoNothing({ target: [transcripts.utteranceId, transcripts.type] });
        const [found] = await tx
          .select({ id: transcripts.id })
          .from(transcripts)
          .where(and(eq(transcripts.utteranceId, parsed.utteranceId), eq(transcripts.type, parsed.type)));
        if (!found) throw new AppError("INTERNAL_ERROR", "The transcript could not be created.");
        const transcript = await lockTranscript(tx, found.id);
        const current = await currentRevisionOf(tx, transcript.id);

        if (current && current.text === parsed.text) {
          return {
            transcript: await buildTranscriptView(tx, transcript),
            revision: toRevisionView(current),
            created: false,
          };
        }

        if (
          parsed.expectedCurrentRevisionId !== undefined &&
          (current?.id ?? null) !== parsed.expectedCurrentRevisionId
        ) {
          throw new AppError(
            "CONFLICT",
            "Another revision of this transcript was saved in the meantime. Reload the utterance, compare the texts and save again.",
            { currentRevisionId: current?.id ?? null },
          );
        }

        const wasVerified = transcript.status === "verified";
        if (wasVerified && !parsed.changeReason) {
          throw new AppError(
            "VALIDATION_ERROR",
            "This transcript is verified. Give a change reason to save a new revision.",
            { issues: [{ path: "changeReason", message: "A change reason is required for a verified transcript." }] },
          );
        }

        if (parsed.derivedFromRevisionId) {
          const [source] = await tx
            .select({ utteranceId: transcripts.utteranceId, type: transcripts.type })
            .from(transcriptRevisions)
            .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
            .where(eq(transcriptRevisions.id, parsed.derivedFromRevisionId));
          if (!source || source.utteranceId !== parsed.utteranceId || source.type !== derivationSource) {
            throw new AppError(
              "VALIDATION_ERROR",
              `The ${TRANSCRIPT_TYPE_LABELS[parsed.type]} transcript can only be derived from a revision of the ${
                derivationSource ? TRANSCRIPT_TYPE_LABELS[derivationSource] : ""
              } transcript of the same utterance.`,
            );
          }
        }

        const [numbers] = await tx
          .select({ highest: max(transcriptRevisions.revisionNumber) })
          .from(transcriptRevisions)
          .where(eq(transcriptRevisions.transcriptId, transcript.id));
        const revisionNumber = (numbers?.highest ?? 0) + 1;

        // The old revision is switched off first: only one revision may be current.
        if (current) {
          await tx
            .update(transcriptRevisions)
            .set({ isCurrent: false })
            .where(eq(transcriptRevisions.id, current.id));
        }
        const [revision] = await tx
          .insert(transcriptRevisions)
          .values({
            transcriptId: transcript.id,
            revisionNumber,
            text: parsed.text,
            derivedFromRevisionId: parsed.derivedFromRevisionId ?? null,
            createdByType: "researcher",
            createdByLabel: resolveLabel(ctx, parsed.annotatorLabel),
            changeReason: parsed.changeReason ?? null,
            transcriptionConventionVersion: scope.settings.transcriptionConventionVersion ?? null,
            isCurrent: true,
            createdAt: ctx.now(),
          })
          .returning();
        if (!revision) throw new AppError("INTERNAL_ERROR", "The revision could not be stored.");

        const status: ReviewStatus = parsed.needsReview ? "needs_review" : "draft";
        const [updated] = await tx
          .update(transcripts)
          .set({ status })
          .where(eq(transcripts.id, transcript.id))
          .returning();
        if (!updated) throw new AppError("INTERNAL_ERROR", "The transcript could not be updated.");

        // The audit row refers to revisions by id. The text itself stays in the revisions.
        await recordAudit(tx, {
          action: wasVerified ? "transcript.revise_verified" : "transcript.save_revision",
          entityType: "transcript",
          entityId: transcript.id,
          before: {
            status: transcript.status,
            currentRevisionId: current?.id ?? null,
            revisionNumber: current?.revisionNumber ?? null,
          },
          after: {
            utteranceId: parsed.utteranceId,
            type: parsed.type,
            status,
            currentRevisionId: revision.id,
            revisionNumber,
            changeReason: parsed.changeReason ?? null,
            derivedFromRevisionId: parsed.derivedFromRevisionId ?? null,
          },
          actorLabel: resolveLabel(ctx, parsed.annotatorLabel),
        });

        return {
          transcript: await buildTranscriptView(tx, updated),
          revision: toRevisionView(revision),
          created: true,
        };
      });
    } catch (error) {
      // The row lock normally prevents this. If two saves still collide on a
      // unique index, the whole transaction was rolled back and can run again.
      const collided = REVISION_UNIQUE_INDEXES.some((name) => isUniqueViolation(error, name));
      if (!collided) throw error;
      if (attempt >= MAX_SAVE_ATTEMPTS) {
        throw new AppError(
          "CONFLICT",
          "Another revision of this transcript was saved at the same time. Reload the utterance and save again.",
          undefined,
          { cause: error },
        );
      }
    }
  }
}

// The same save, addressed by transcript id (POST /api/admin/transcripts/:id/revisions).
export async function saveRevisionForTranscript(
  ctx: ServiceContext,
  input: SaveRevisionForTranscriptInput,
): Promise<transcriptSchemas.SaveRevisionResponse> {
  const { transcriptId, ...body } = parseInput(saveByTranscriptInputSchema, input);
  const transcript = await loadTranscript(ctx.db, transcriptId);
  if (!isHumanTranscriptType(transcript.type)) {
    throw new AppError(
      "IMMUTABLE_RECORD",
      "The ASR transcript (A) is a model output and cannot be edited. Write a corrected transcript (A*) instead.",
    );
  }
  return saveTranscriptRevision(ctx, { ...body, utteranceId: transcript.utteranceId, type: transcript.type });
}

// Marks the current revision as verified. `revisionId` must be the current
// revision: when someone saved a newer one in the meantime the call is rejected
// with CONFLICT, so nobody verifies a text they have not seen.
export async function verifyTranscript(
  ctx: ServiceContext,
  input: VerifyTranscriptInput,
): Promise<transcriptSchemas.VerifyTranscriptResponse> {
  const parsed = parseInput(verifyInputSchema, input);
  return ctx.db.transaction(async (tx) => {
    const transcript = await lockTranscript(tx, parsed.transcriptId);
    if (!isHumanTranscriptType(transcript.type)) {
      throw new AppError(
        "INVALID_STATE",
        "The ASR transcript (A) is a model output. Only the human transcripts A*, B and C are verified.",
      );
    }
    const current = await currentRevisionOf(tx, transcript.id);
    if (!current) throw new AppError("INVALID_STATE", "The transcript has no text to verify yet.");
    if (current.id !== parsed.revisionId) {
      throw new AppError(
        "CONFLICT",
        "This is not the current revision any more. Reload the utterance and check the newer text before verifying.",
        { currentRevisionId: current.id },
      );
    }
    if (transcript.status === "verified" && current.verifiedAt !== null) {
      // Already verified: repeating the call changes nothing.
      return { transcript: await buildTranscriptView(tx, transcript), revision: toRevisionView(current) };
    }

    const verifiedByLabel = resolveLabel(ctx, parsed.verifiedByLabel);
    const [revision] = await tx
      .update(transcriptRevisions)
      .set({
        verifiedAt: ctx.now(),
        verifiedByLabel,
        verificationNotes: parsed.verificationNotes ?? null,
      })
      .where(eq(transcriptRevisions.id, current.id))
      .returning();
    const [updated] = await tx
      .update(transcripts)
      .set({ status: "verified" })
      .where(eq(transcripts.id, transcript.id))
      .returning();
    if (!revision || !updated) throw new AppError("INTERNAL_ERROR", "The verification could not be stored.");

    await recordAudit(tx, {
      action: "transcript.verify",
      entityType: "transcript",
      entityId: transcript.id,
      before: { status: transcript.status },
      after: {
        status: "verified",
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        verifiedByLabel,
      },
      actorLabel: verifiedByLabel,
    });

    return { transcript: await buildTranscriptView(tx, updated), revision: toRevisionView(revision) };
  });
}

// Moves a transcript between draft and needs_review (asks for, or takes back, a
// second review). A verified transcript is not changed here: saving a new
// revision with a change reason is the only way to reopen it.
export async function setTranscriptStatus(
  ctx: ServiceContext,
  input: SetTranscriptStatusInput,
): Promise<transcriptSchemas.SetTranscriptStatusResponse> {
  const parsed = parseInput(setStatusInputSchema, input);
  return ctx.db.transaction(async (tx) => {
    const transcript = await lockTranscript(tx, parsed.transcriptId);
    if (!isHumanTranscriptType(transcript.type)) {
      throw new AppError("INVALID_STATE", "The ASR transcript (A) is a model output and has no review status.");
    }
    if (transcript.status === "verified") {
      throw new AppError(
        "INVALID_STATE",
        "The transcript is verified. Save a new revision with a change reason to reopen it.",
      );
    }
    const current = await currentRevisionOf(tx, transcript.id);
    if (!current) throw new AppError("INVALID_STATE", "The transcript has no text yet.");
    if (transcript.status === parsed.status) {
      return { transcript: await buildTranscriptView(tx, transcript) };
    }
    const [updated] = await tx
      .update(transcripts)
      .set({ status: parsed.status })
      .where(eq(transcripts.id, transcript.id))
      .returning();
    if (!updated) throw new AppError("INTERNAL_ERROR", "The transcript could not be updated.");
    await recordAudit(tx, {
      action: "transcript.set_status",
      entityType: "transcript",
      entityId: transcript.id,
      before: { status: transcript.status, currentRevisionId: current.id },
      after: { status: parsed.status, currentRevisionId: current.id },
      actorLabel: ctx.actorLabel,
    });
    return { transcript: await buildTranscriptView(tx, updated) };
  });
}

// All revisions of one transcript, newest first.
export async function getTranscriptHistory(
  ctx: ServiceContext,
  transcriptId: string,
): Promise<transcriptSchemas.TranscriptHistoryResponse> {
  const id = parseInput(z.uuid(), transcriptId);
  const transcript = await loadTranscript(ctx.db, id);
  const revisions = await ctx.db
    .select()
    .from(transcriptRevisions)
    .where(eq(transcriptRevisions.transcriptId, id))
    .orderBy(desc(transcriptRevisions.revisionNumber));
  return {
    transcript: await buildTranscriptView(ctx.db, transcript),
    revisions: revisions.map(toRevisionView),
  };
}
