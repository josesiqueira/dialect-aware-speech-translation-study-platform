// Media access for the authenticated admin routes and the audited media
// deletion workflow (spec 35, 36, 38, 111, 116, 123, 135).
//
// Deletion policy: this code offers the workflow and records what was done. It
// does not decide when a recording may or must be deleted. That is decided by
// the approved study policy and the privacy notice (spec 86, 111).
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { exportJobs, mediaAssets, sessions, syntheses, utterances } from "@dialect/db";
import { AppError, corpusSchemas, type UtteranceStatus } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { loadSynthesisOrigin } from "./lineage";
import { parseInput, toIso, type MediaAssetRow } from "./shared";

export type { MediaAssetRow };

const deleteMediaSchema = z.object({
  mediaAssetId: z.uuid(),
  reason: z.string().trim().min(1, "a reason is required").max(corpusSchemas.MAX_REASON_LENGTH),
  confirmationPhrase: z.string().optional(),
});
export type DeleteMediaInput = z.input<typeof deleteMediaSchema>;

function notFound(mediaAssetId: string): AppError {
  return new AppError("MEDIA_NOT_FOUND", "The requested media does not exist.", { mediaAssetId });
}

// Kinds that the media routes never serve. An export archive holds a whole
// data set. It is downloaded only through the export download route, which
// writes an export.download audit row for every download (spec 132).
export const NOT_STREAMABLE_MEDIA_KINDS: readonly string[] = ["export_archive"];

// The media row for the streaming and download routes. Throws MEDIA_NOT_FOUND
// (HTTP 404) for an unknown id, a malformed id, an asset that was deleted and
// an export archive (the answer does not reveal that the id exists).
export async function getMediaForStreaming(ctx: ServiceContext, mediaAssetId: string): Promise<MediaAssetRow> {
  if (!z.uuid().safeParse(mediaAssetId).success) throw notFound(mediaAssetId);
  const [asset] = await ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaAssetId));
  if (!asset || asset.deletedAt !== null) throw notFound(mediaAssetId);
  if (NOT_STREAMABLE_MEDIA_KINDS.includes(asset.kind)) throw notFound(mediaAssetId);
  return asset;
}

const EXTENSIONS: Record<string, string> = {
  wav: "wav",
  webm: "webm",
  matroska: "mka",
  ogg: "ogg",
  mp4: "m4a",
  mp3: "mp3",
  flac: "flac",
  aac: "aac",
  zip: "zip",
};
const MIME_EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "application/zip": "zip",
};

function extensionOf(asset: MediaAssetRow): string {
  const fromContainer = asset.container ? EXTENSIONS[asset.container.toLowerCase()] : undefined;
  const mime = asset.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return fromContainer ?? MIME_EXTENSIONS[mime] ?? "bin";
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

const TRANSCRIPT_FILE_LABELS: Record<string, string> = {
  asr: "A",
  asr_corrected: "Astar",
  human_dialect: "B",
  normalized: "C",
};

async function utterancePrefix(ctx: ServiceContext, utteranceId: string): Promise<string | null> {
  // Position of the utterance in its session, in the order the participant spoke.
  const result = await ctx.db.execute<{ participant_code: string; ordinal: string }>(sql`
    SELECT participant_code, ordinal FROM (
      SELECT u.id, s.participant_code,
        row_number() OVER (PARTITION BY u.session_id ORDER BY p.sequence_index, u.turn_index) AS ordinal
      FROM utterances u
      JOIN sessions s ON s.id = u.session_id
      JOIN task_presentations p ON p.id = u.task_presentation_id
      WHERE u.session_id = (SELECT session_id FROM utterances WHERE id = ${utteranceId})
    ) ranked WHERE id = ${utteranceId}`);
  const row = result.rows[0];
  if (!row) return null;
  return `${safePart(row.participant_code)}_U-${String(Number(row.ordinal)).padStart(2, "0")}`;
}

// Human-friendly file name for a download (spec 123), built from pseudonymous
// codes: "P-7K4M9Q_U-03_source.wav". It never contains the storage key, and the
// participant code and utterance number come first when they are known.
export async function getMediaDownloadName(ctx: ServiceContext, asset: MediaAssetRow): Promise<string> {
  const extension = extensionOf(asset);
  const shortId = asset.id.slice(0, 8);

  if (asset.kind === "tts_audio") {
    const origin = asset.entityId ? await loadSynthesisOrigin(ctx.db, asset.entityId) : null;
    const fallback = origin
      ? null
      : (
          await ctx.db
            .select({ id: syntheses.id })
            .from(syntheses)
            .where(eq(syntheses.mediaAssetId, asset.id))
            .limit(1)
        )[0];
    const resolved = origin ?? (fallback ? await loadSynthesisOrigin(ctx.db, fallback.id) : null);
    const prefix = resolved?.utteranceId ? await utterancePrefix(ctx, resolved.utteranceId) : null;
    if (resolved && prefix) {
      const parts = [
        prefix,
        resolved.transcriptType ? TRANSCRIPT_FILE_LABELS[resolved.transcriptType] : null,
        resolved.translationCondition ? safePart(resolved.translationCondition) : null,
        `tts-${safePart(resolved.ttsCondition)}`,
        shortId,
      ].filter((part): part is string => Boolean(part));
      return `${parts.join("_")}.${extension}`;
    }
    return `tts_${shortId}.${extension}`;
  }

  if (asset.utteranceId) {
    const prefix = await utterancePrefix(ctx, asset.utteranceId);
    const role = asset.kind === "source_audio_derived" ? "source-derived" : "source";
    if (prefix) return `${prefix}_${role}.${extension}`;
  }
  if (asset.sessionId) {
    const [session] = await ctx.db
      .select({ participantCode: sessions.participantCode })
      .from(sessions)
      .where(eq(sessions.id, asset.sessionId));
    if (session) return `${safePart(session.participantCode)}_${safePart(asset.kind)}_${shortId}.${extension}`;
  }
  return `${safePart(asset.kind)}_${shortId}.${extension}`;
}

// Records that the admin downloaded a media file as an attachment (spec 132).
// Called by the explicit download route only. Streaming for the audio player is
// not recorded: it would add a row for every seek.
export async function recordMediaDownload(
  ctx: ServiceContext,
  asset: MediaAssetRow,
  fileName: string,
): Promise<void> {
  await recordAudit(ctx.db, {
    action: "media.download",
    entityType: "media_asset",
    entityId: asset.id,
    before: null,
    after: {
      kind: asset.kind,
      fileName,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      sessionId: asset.sessionId,
      utteranceId: asset.utteranceId,
    },
    actorLabel: ctx.actorLabel,
  });
}

// The audited media deletion workflow. The row stays as provenance (hash, size,
// format and deletion reason remain known); the stored file is removed.
//
// - An asset that nothing refers to can be deleted with a reason.
// - An asset that is the accepted recording of an utterance, the audio of a
//   synthesis or the file of an export needs the typed confirmation phrase.
// - Deleting the accepted recording of an utterance marks the utterance
//   "excluded" (or "invalid" when it was never submitted) with a reason, so no
//   utterance in the analysis set points at a missing recording.
// - Derived copies of the asset are deleted with it.
export async function deleteMedia(ctx: ServiceContext, input: DeleteMediaInput): Promise<corpusSchemas.MediaDeleteResult> {
  const parsed = parseInput(deleteMediaSchema, input);

  const committed = await ctx.db.transaction(async (tx) => {
    const [asset] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, parsed.mediaAssetId)).for("update");
    if (!asset) throw notFound(parsed.mediaAssetId);
    // Derived copies (for example the canonical WAV of a compressed recording).
    const derived = await tx
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.derivedFromMediaAssetId, asset.id))
      .for("update");
    const derivedToMark = derived.filter((row) => row.deletedAt === null);

    for (const row of [asset, ...derived]) {
      if (row.storageDriver !== ctx.storage.driver) {
        throw new AppError(
          "STORAGE_ERROR",
          `This file is stored with the "${row.storageDriver}" driver, but the server is configured for ` +
            `"${ctx.storage.driver}". The file cannot be removed from here.`,
          { reason: "storage_driver_mismatch" },
        );
      }
    }

    if (asset.deletedAt !== null) {
      // A repeated request, for example after the file removal failed the first time.
      return {
        asset,
        derived: derived.filter((row) => row.deletedAt !== null),
        alreadyDeleted: true,
        utterance: null,
      };
    }

    const [acceptedBy] = await tx
      .select()
      .from(utterances)
      .where(eq(utterances.acceptedMediaAssetId, asset.id))
      .for("update");
    const [usedBySynthesis] = await tx
      .select({ id: syntheses.id })
      .from(syntheses)
      .where(eq(syntheses.mediaAssetId, asset.id))
      .limit(1);
    const [usedByExport] = await tx
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(eq(exportJobs.mediaAssetId, asset.id))
      .limit(1);
    const referenced = Boolean(acceptedBy || usedBySynthesis || usedByExport);
    if (referenced && parsed.confirmationPhrase !== corpusSchemas.MEDIA_DELETE_PHRASE) {
      throw new AppError(
        "VALIDATION_ERROR",
        acceptedBy
          ? "This is the accepted recording of an utterance. Type the confirmation phrase to delete it."
          : "This file is used by a stored output. Type the confirmation phrase to delete it.",
        { confirmationRequired: true, confirmationPhrase: corpusSchemas.MEDIA_DELETE_PHRASE },
      );
    }

    const now = ctx.now();
    const deletion = { reason: parsed.reason, ...(ctx.actorLabel ? { deletedByLabel: ctx.actorLabel } : {}) };
    for (const row of [asset, ...derivedToMark]) {
      await tx
        .update(mediaAssets)
        .set({ deletedAt: now, metadataJson: { ...(row.metadataJson ?? {}), deletion } })
        .where(eq(mediaAssets.id, row.id));
      await recordAudit(tx, {
        action: "media.delete",
        entityType: "media_asset",
        entityId: row.id,
        before: { deletedAt: null, kind: row.kind, sha256: row.sha256, sizeBytes: row.sizeBytes },
        after: {
          deletedAt: now.toISOString(),
          reason: parsed.reason,
          utteranceId: row.utteranceId,
          ...(row.id !== asset.id ? { deletedWithMediaAssetId: asset.id } : {}),
        },
        actorLabel: ctx.actorLabel,
      });
    }

    let utterance: { id: string; status: UtteranceStatus } | null = null;
    if (acceptedBy) {
      // A submitted utterance can only become "excluded" (database rule). One
      // that never reached "submitted" is marked "invalid".
      const wasSubmitted = acceptedBy.status === "submitted" || acceptedBy.status === "excluded";
      const status: UtteranceStatus = wasSubmitted ? "excluded" : "invalid";
      const exclusionReason = `Source recording deleted: ${parsed.reason}`;
      await tx.update(utterances).set({ status, exclusionReason }).where(eq(utterances.id, acceptedBy.id));
      await recordAudit(tx, {
        action: "utterance.exclude",
        entityType: "utterance",
        entityId: acceptedBy.id,
        before: { status: acceptedBy.status, exclusionReason: acceptedBy.exclusionReason },
        after: { status, exclusionReason, deletedMediaAssetId: asset.id },
        actorLabel: ctx.actorLabel,
      });
      utterance = { id: acceptedBy.id, status };
    }

    return { asset: { ...asset, deletedAt: now }, derived, alreadyDeleted: false, utterance };
  });

  // The files are removed only after the database change is committed, so a
  // failed transaction never leaves a row that points at a missing file.
  let storageObjectRemoved = true;
  for (const row of [committed.asset, ...committed.derived]) {
    try {
      await ctx.storage.delete(row.storageKey);
    } catch (error) {
      storageObjectRemoved = false;
      ctx.logger.error(
        { mediaAssetId: row.id, error: error instanceof Error ? error.message : String(error) },
        "media file removal failed after the record was marked deleted",
      );
    }
  }
  if (!storageObjectRemoved) {
    throw new AppError(
      "STORAGE_ERROR",
      "The recording is marked as deleted, but its file could not be removed from storage. Run the deletion again.",
      { mediaAssetId: committed.asset.id, reason: "object_not_removed" },
    );
  }

  return {
    mediaAssetId: committed.asset.id,
    deletedAt: toIso(committed.asset.deletedAt as Date),
    alreadyDeleted: committed.alreadyDeleted,
    storageObjectRemoved,
    derivedAssetIds: committed.derived.map((row) => row.id),
    utterance: committed.utterance,
  };
}
