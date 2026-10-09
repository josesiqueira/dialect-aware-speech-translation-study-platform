// Canonical WAV derivation of a compressed fallback recording (spec 31.2, 64, 106).
//
// The uploaded file stays unchanged as `source_audio_raw` and stays the accepted
// asset of the utterance. This step adds a separate `source_audio_derived`
// asset that points at its source and records how it was made.
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { and, eq } from "drizzle-orm";
import { mediaAssets, sessions, studies } from "@dialect/db";
import { AppError } from "@dialect/domain";
import { createHashingStream, deriveCanonicalWav, sourceAudioKey } from "@dialect/storage";
import type { ServiceContext } from "../context";

export type MediaAssetRow = typeof mediaAssets.$inferSelect;

export type DeriveWavResult = {
  // False when the derived asset already existed (a second delivery of the job).
  created: boolean;
  asset: MediaAssetRow;
};

async function findDerived(ctx: ServiceContext, sourceAssetId: string): Promise<MediaAssetRow | undefined> {
  const [existing] = await ctx.db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.derivedFromMediaAssetId, sourceAssetId), eq(mediaAssets.kind, "source_audio_derived")))
    .limit(1);
  return existing;
}

export async function deriveWavForAsset(ctx: ServiceContext, mediaAssetId: string): Promise<DeriveWavResult> {
  const [source] = await ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaAssetId)).limit(1);
  if (!source) throw new AppError("MEDIA_NOT_FOUND", "The recording was not found.", { mediaAssetId });
  if (source.kind !== "source_audio_raw") {
    throw new AppError(
      "VALIDATION_ERROR",
      `Only a compressed source recording (source_audio_raw) is converted to WAV. This file is ${source.kind}.`,
      { mediaAssetId },
    );
  }
  if (source.deletedAt) {
    throw new AppError("MEDIA_NOT_FOUND", "The recording was deleted and can no longer be converted.", { mediaAssetId });
  }
  if (!source.sessionId || !source.utteranceId) {
    throw new AppError("INVALID_STATE", "The recording is not linked to a session and an utterance.", { mediaAssetId });
  }
  const existing = await findDerived(ctx, source.id);
  if (existing) return { created: false, asset: existing };

  const [owner] = await ctx.db
    .select({ studySlug: studies.slug })
    .from(sessions)
    .innerJoin(studies, eq(studies.id, sessions.studyId))
    .where(eq(sessions.id, source.sessionId))
    .limit(1);
  if (!owner) throw new AppError("NOT_FOUND", "The session of the recording was not found.", { mediaAssetId });

  // Neither the source nor the derived WAV is held in memory: the source is
  // streamed from storage to a temporary file (hashed on the way), ffmpeg writes
  // the WAV to a second temporary file, and that file is streamed into storage.
  // A long compressed recording decodes to a WAV many times its size.
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dialect-derive-source-"));
  let stored: Awaited<ReturnType<typeof ctx.storage.put>>;
  let derived: Extract<Awaited<ReturnType<typeof deriveCanonicalWav>>, { kind: "file" }> | null = null;
  const assetId = randomUUID();
  const key = sourceAudioKey({
    studySlug: owner.studySlug,
    sessionId: source.sessionId,
    utteranceId: source.utteranceId,
    assetId,
    extension: "wav",
  });
  try {
    const sourcePath = path.join(workDirectory, "source");
    const hashing = createHashingStream();
    await pipeline(await ctx.storage.get(source.storageKey), hashing, createWriteStream(sourcePath));
    if (hashing.sha256 !== source.sha256) {
      throw new AppError("STORAGE_ERROR", "The stored recording does not match its recorded SHA-256.", { mediaAssetId });
    }

    // Sample rate and channel count of the source are kept. Nothing is resampled.
    const result = await deriveCanonicalWav({ data: sourcePath, output: "file" });
    if (result.kind !== "file") throw new AppError("INTERNAL_ERROR", "The WAV derivation returned no file.");
    derived = result;
    stored = await ctx.storage.put({ key, body: createReadStream(result.filePath), contentType: "audio/wav" });
    if (stored.sizeBytes !== result.sizeBytes) {
      await ctx.storage.delete(key).catch(() => undefined);
      throw new AppError("STORAGE_ERROR", "The derived recording was not stored completely.", { mediaAssetId });
    }
  } finally {
    await derived?.cleanup().catch(() => undefined);
    await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  const wav = derived.wav;
  const provenance = derived.provenance;
  try {
    const asset = await ctx.db.transaction(async (tx) => {
      // The lock on the source row serializes two deliveries of the same job.
      await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.id, source.id)).for("update");
      const [again] = await tx
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.derivedFromMediaAssetId, source.id), eq(mediaAssets.kind, "source_audio_derived")))
        .limit(1);
      if (again) return { created: false, asset: again };
      const [row] = await tx
        .insert(mediaAssets)
        .values({
          id: assetId,
          studyId: source.studyId,
          sessionId: source.sessionId,
          utteranceId: source.utteranceId,
          entityType: "utterance",
          entityId: source.utteranceId,
          kind: "source_audio_derived",
          storageDriver: stored.driver,
          storageKey: stored.key,
          mimeType: "audio/wav",
          container: "wav",
          codec: wav.audioFormat === "ieee_float" ? `pcm_f${wav.bitDepth}le` : `pcm_s${wav.bitDepth}le`,
          sampleRateHz: wav.sampleRateHz,
          channels: wav.channels,
          bitDepth: wav.bitDepth,
          durationMs: wav.durationMs,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          // The derived file is PCM, but its content went through the lossy
          // codec of the source. The class of the source is kept so that it is
          // never mistaken for a lossless capture.
          captureMethod: source.captureMethod,
          captureQualityClass: source.captureQualityClass,
          derivedFromMediaAssetId: source.id,
          metadataJson: { derivation: provenance, sourceSha256: source.sha256 },
          createdAt: ctx.now(),
        })
        .returning();
      if (!row) throw new AppError("DATABASE_ERROR", "The derived audio metadata could not be stored.");
      return { created: true, asset: row };
    });
    if (!asset.created) await ctx.storage.delete(key).catch(() => undefined);
    return asset;
  } catch (error) {
    await ctx.storage.delete(key).catch(() => undefined);
    throw error;
  }
}
