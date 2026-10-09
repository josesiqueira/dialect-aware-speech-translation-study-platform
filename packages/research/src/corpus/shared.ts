// Helpers shared by the corpus services. Not exported from the package.
import { eq, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { studies, type DbOrTx, type StudySettings, type mediaAssets, type modelRuns } from "@dialect/db";
import { AppError, corpusSchemas, type TranscriptType } from "@dialect/domain";
import { resolveStudy as resolveSharedStudy } from "../study";

export type StudyRow = typeof studies.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type ModelRunRow = typeof modelRuns.$inferSelect;

export const DEFAULT_ADMIN_TIMEZONE = "UTC";
// A worker that has not sent a heartbeat for this long counts as not healthy.
export const WORKER_STALE_AFTER_MS = 60_000;

export function toIso(value: Date): string;
export function toIso(value: Date | null): string | null;
export function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

// Raw SQL results give timestamps as text.
export function sqlTimeToIso(value: string | Date): string;
export function sqlTimeToIso(value: string | Date | null): string | null;
export function sqlTimeToIso(value: string | Date | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

// Validates service input with the shared schema. A wrong shape becomes a
// VALIDATION_ERROR with the same details the API wrapper produces.
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError("VALIDATION_ERROR", "The request is not valid.", {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

export function adminTimezoneOf(settings: StudySettings | null | undefined): string {
  const zone = settings?.adminTimezone;
  return zone && corpusSchemas.isValidTimeZone(zone) ? zone : DEFAULT_ADMIN_TIMEZONE;
}

export async function loadStudy(db: DbOrTx, studyId: string): Promise<StudyRow> {
  const [study] = await db.select().from(studies).where(eq(studies.id, studyId)).limit(1);
  if (!study) throw new AppError("NOT_FOUND", "The study does not exist.", { studyId });
  return study;
}

// The deployment runs one study. Routes call this without an id and get the
// study that was created first.
// The shared implementation is in ../study.ts.
export function resolveStudy(db: DbOrTx, studyId?: string | null): Promise<StudyRow> {
  return resolveSharedStudy(db, studyId);
}

export const TRANSCRIPT_ORDER: TranscriptType[] = ["asr", "asr_corrected", "human_dialect", "normalized"];

// "48 kHz, mono, PCM 16-bit". Parts that are not known are left out.
export function captureSummary(asset: {
  sampleRateHz: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  bitDepth: number | null;
}): string {
  const parts: string[] = [];
  if (asset.sampleRateHz) {
    const khz = asset.sampleRateHz / 1000;
    parts.push(`${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`);
  }
  if (asset.channels) parts.push(asset.channels === 1 ? "mono" : asset.channels === 2 ? "stereo" : `${asset.channels} channels`);
  const codec = asset.codec ?? "";
  if (codec.startsWith("pcm")) {
    const float = codec.includes("f32") || codec.includes("f64");
    parts.push(asset.bitDepth ? `PCM ${asset.bitDepth}-bit${float ? " float" : ""}` : "PCM");
  } else if (codec) {
    parts.push(asset.container && asset.container !== codec ? `${codec} in ${asset.container}` : codec);
  } else if (asset.container) {
    parts.push(asset.container);
  }
  return parts.length > 0 ? parts.join(", ") : "format not recorded";
}

export function toMediaView(asset: MediaAssetRow): corpusSchemas.MediaAssetView {
  return {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    container: asset.container,
    codec: asset.codec,
    sampleRateHz: asset.sampleRateHz,
    channels: asset.channels,
    bitDepth: asset.bitDepth,
    durationMs: asset.durationMs,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    captureMethod: asset.captureMethod,
    captureQualityClass: asset.captureQualityClass,
    captureSummary: captureSummary(asset),
    derivedFromMediaAssetId: asset.derivedFromMediaAssetId,
    createdAt: toIso(asset.createdAt),
    deletedAt: toIso(asset.deletedAt),
    deletionReason: asset.metadataJson?.deletion?.reason ?? null,
  };
}

// Finds the utterance, and through it the session, that a model run worked on.
// The processing steps use the source entity types utterance (ASR),
// transcript_revision (translation) and translation (TTS). media_asset and the
// utterance id of the input manifest are accepted too.
//
// Usage: sql`SELECT ... FROM model_runs mr ${MODEL_RUN_UTTERANCE_JOINS} WHERE ...`
// then use ${MODEL_RUN_UTTERANCE_ID} for the utterance id of the run.
export const MODEL_RUN_UTTERANCE_JOINS: SQL = sql`
  LEFT JOIN utterances mru_u ON mr.source_entity_type = 'utterance' AND mru_u.id = mr.source_entity_id
  LEFT JOIN media_assets mru_m ON mr.source_entity_type = 'media_asset' AND mru_m.id = mr.source_entity_id
  LEFT JOIN transcript_revisions mru_r ON mr.source_entity_type = 'transcript_revision' AND mru_r.id = mr.source_entity_id
  LEFT JOIN transcripts mru_t ON mru_t.id = mru_r.transcript_id
  LEFT JOIN translations mru_tl ON mr.source_entity_type = 'translation' AND mru_tl.id = mr.source_entity_id
  LEFT JOIN transcript_revisions mru_r2 ON mru_r2.id = mru_tl.source_transcript_revision_id
  LEFT JOIN transcripts mru_t2 ON mru_t2.id = mru_r2.transcript_id
  LEFT JOIN utterances mru_x ON mru_x.id::text = mr.input_manifest_json->>'utteranceId'`;

export const MODEL_RUN_UTTERANCE_ID: SQL = sql`coalesce(mru_u.id, mru_m.utterance_id, mru_t.utterance_id, mru_t2.utterance_id, mru_x.id)`;

// A failed run counts as an open error until a later run of the same work
// succeeded. Model runs are immutable, so a retry is a new row.
export const MODEL_RUN_UNRESOLVED_FAILURE: SQL = sql`
  mr.status = 'failed' AND NOT EXISTS (
    SELECT 1 FROM model_runs ok
    WHERE ok.status = 'succeeded'
      AND ok.stage = mr.stage
      AND ok.source_entity_type = mr.source_entity_type
      AND ok.source_entity_id = mr.source_entity_id
      AND ok.condition_key IS NOT DISTINCT FROM mr.condition_key
      AND ok.processing_batch_id IS NOT DISTINCT FROM mr.processing_batch_id
      AND ok.started_at >= mr.started_at
  )`;

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
