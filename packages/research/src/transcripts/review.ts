// Read model of the review screen: everything about one utterance that a
// researcher needs to transcribe and review it (spec 46, Appendix C).
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  mediaAssets,
  protocolTasks,
  protocolVersions,
  sessions,
  studies,
  taskPresentations,
  transcripts,
  utterances,
} from "@dialect/db";
import { AppError, TRANSCRIPT_TYPES, type transcriptSchemas, type TranscriptType } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { listDifferenceAnnotations } from "./annotations";
import { listFlagsAndNotes } from "./flags";
import { buildTranscriptViews, DEFAULT_ADMIN_TIMEZONE, parseInput, toIso } from "./shared";

export async function getUtteranceForReview(
  ctx: ServiceContext,
  utteranceId: string,
): Promise<transcriptSchemas.UtteranceForReview> {
  const id = parseInput(z.uuid(), utteranceId);
  const [row] = await ctx.db
    .select({
      utterance: utterances,
      session: {
        id: sessions.id,
        participantCode: sessions.participantCode,
        mode: sessions.mode,
        status: sessions.status,
        excluded: sessions.excluded,
        protocolVersionId: sessions.protocolVersionId,
      },
      protocolVersionNumber: protocolVersions.versionNumber,
      presentation: {
        titleSnapshot: taskPresentations.titleSnapshot,
        promptSnapshot: taskPresentations.promptSnapshot,
        contextSnapshot: taskPresentations.contextSnapshot,
        instructionsSnapshot: taskPresentations.instructionsSnapshot,
        sequenceIndex: taskPresentations.sequenceIndex,
      },
      taskKey: protocolTasks.taskKey,
      taskType: protocolTasks.taskType,
      settings: studies.settingsJson,
    })
    .from(utterances)
    .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
    .innerJoin(studies, eq(studies.id, sessions.studyId))
    .innerJoin(protocolVersions, eq(protocolVersions.id, sessions.protocolVersionId))
    .innerJoin(taskPresentations, eq(taskPresentations.id, utterances.taskPresentationId))
    .innerJoin(protocolTasks, eq(protocolTasks.id, taskPresentations.protocolTaskId))
    .where(eq(utterances.id, id));
  if (!row) throw new AppError("NOT_FOUND", "The utterance does not exist.");

  const mediaId = row.utterance.acceptedMediaAssetId;
  const [media] = mediaId ? await ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId)) : [];

  const transcriptRows = await ctx.db.select().from(transcripts).where(eq(transcripts.utteranceId, id));
  const views = await buildTranscriptViews(ctx.db, transcriptRows);
  const byType = Object.fromEntries(
    TRANSCRIPT_TYPES.map((type) => [type, views.find((view) => view.type === type) ?? null]),
  ) as Record<TranscriptType, transcriptSchemas.TranscriptView | null>;

  const differenceAnnotations = await listDifferenceAnnotations(ctx.db, id);
  const { flags, notes } = await listFlagsAndNotes(
    ctx.db,
    id,
    transcriptRows.map((transcript) => ({ id: transcript.id, type: transcript.type })),
  );

  return {
    utterance: {
      id: row.utterance.id,
      status: row.utterance.status,
      promptSnapshot: row.utterance.promptSnapshot,
      turnIndex: row.utterance.turnIndex,
      isFollowup: row.utterance.followupId !== null,
      durationMs: row.utterance.durationMs,
      submittedAt: toIso(row.utterance.submittedAt),
      attemptCount: row.utterance.attemptCount,
      flagged: row.utterance.flagged,
      flagNotes: row.utterance.flagNotes,
      exclusionReason: row.utterance.exclusionReason,
    },
    session: { ...row.session, protocolVersionNumber: row.protocolVersionNumber },
    task: { taskKey: row.taskKey, taskType: row.taskType, ...row.presentation },
    media: media
      ? {
          id: media.id,
          kind: media.kind,
          mimeType: media.mimeType,
          container: media.container,
          codec: media.codec,
          sampleRateHz: media.sampleRateHz,
          channels: media.channels,
          bitDepth: media.bitDepth,
          durationMs: media.durationMs,
          sizeBytes: media.sizeBytes,
          sha256: media.sha256,
          captureMethod: media.captureMethod,
          captureQualityClass: media.captureQualityClass,
          deleted: media.deletedAt !== null,
        }
      : null,
    transcripts: byType,
    differenceAnnotations,
    flags,
    notes,
    settings: {
      adminTimezone: row.settings.adminTimezone ?? DEFAULT_ADMIN_TIMEZONE,
      transcriptionConventionVersion: row.settings.transcriptionConventionVersion ?? null,
      annotationSchemeVersion: row.settings.annotationSchemeVersion ?? null,
    },
  };
}
