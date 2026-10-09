// Helpers shared by the transcript services. Not exported from the package.
import { and, count, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import {
  modelRuns,
  sessions,
  studies,
  transcriptRevisions,
  transcripts,
  utterances,
  type DbOrTx,
  type StudySettings,
} from "@dialect/db";
import { AppError, transcriptSchemas, type TranscriptType } from "@dialect/domain";
import type { ServiceContext } from "../context";

export type TranscriptRow = typeof transcripts.$inferSelect;
export type TranscriptRevisionRow = typeof transcriptRevisions.$inferSelect;

export const DEFAULT_ADMIN_TIMEZONE = "UTC";

export function toIso(value: Date): string;
export function toIso(value: Date | null): string | null;
export function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
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

// The label stored with a researcher record: the annotator label typed on the
// review page, otherwise the actor of the request (spec 17, 120).
export function resolveLabel(ctx: ServiceContext, label: string | undefined | null): string | null {
  const trimmed = label?.trim();
  return trimmed ? trimmed : ctx.actorLabel;
}

export type UtteranceScope = {
  utteranceId: string;
  utteranceStatus: (typeof utterances.$inferSelect)["status"];
  sessionId: string;
  studyId: string;
  settings: StudySettings;
};

// The utterance with its session and the settings of its study.
export async function loadUtteranceScope(db: DbOrTx, utteranceId: string): Promise<UtteranceScope> {
  const [row] = await db
    .select({
      utteranceId: utterances.id,
      utteranceStatus: utterances.status,
      sessionId: sessions.id,
      studyId: studies.id,
      settings: studies.settingsJson,
    })
    .from(utterances)
    .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
    .innerJoin(studies, eq(studies.id, sessions.studyId))
    .where(eq(utterances.id, utteranceId));
  if (!row) throw new AppError("NOT_FOUND", "The utterance does not exist.");
  return row;
}

export async function loadTranscript(db: DbOrTx, transcriptId: string): Promise<TranscriptRow> {
  const [row] = await db.select().from(transcripts).where(eq(transcripts.id, transcriptId));
  if (!row) throw new AppError("NOT_FOUND", "The transcript does not exist.");
  return row;
}

export function toRevisionView(row: TranscriptRevisionRow): transcriptSchemas.TranscriptRevisionView {
  return {
    id: row.id,
    transcriptId: row.transcriptId,
    revisionNumber: row.revisionNumber,
    text: row.text,
    createdByType: row.createdByType,
    createdByLabel: row.createdByLabel,
    changeReason: row.changeReason,
    transcriptionConventionVersion: row.transcriptionConventionVersion,
    isCurrent: row.isCurrent,
    createdAt: toIso(row.createdAt),
    verifiedAt: toIso(row.verifiedAt),
    verifiedByLabel: row.verifiedByLabel,
    verificationNotes: row.verificationNotes,
    derivedFromRevisionId: row.derivedFromRevisionId,
    sourceModelRunId: row.sourceModelRunId,
  };
}

// Builds the read model of the given transcripts: current revision, number of
// revisions and, for ASR, a summary of the model run behind the current revision.
export async function buildTranscriptViews(
  db: DbOrTx,
  rows: TranscriptRow[],
): Promise<transcriptSchemas.TranscriptView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const currentRows = await db
    .select()
    .from(transcriptRevisions)
    .where(and(inArray(transcriptRevisions.transcriptId, ids), eq(transcriptRevisions.isCurrent, true)));
  const counts = await db
    .select({ transcriptId: transcriptRevisions.transcriptId, total: count() })
    .from(transcriptRevisions)
    .where(inArray(transcriptRevisions.transcriptId, ids))
    .groupBy(transcriptRevisions.transcriptId);

  const runIds = currentRows.map((row) => row.sourceModelRunId).filter((value): value is string => value !== null);
  const runs =
    runIds.length === 0
      ? []
      : await db
          .select({
            id: modelRuns.id,
            provider: modelRuns.provider,
            requestedModel: modelRuns.requestedModel,
            returnedModel: modelRuns.returnedModel,
            status: modelRuns.status,
            finishedAt: modelRuns.finishedAt,
            processingBatchId: modelRuns.processingBatchId,
          })
          .from(modelRuns)
          .where(inArray(modelRuns.id, runIds));

  return rows.map((row) => {
    const current = currentRows.find((revision) => revision.transcriptId === row.id) ?? null;
    const run = current?.sourceModelRunId ? runs.find((candidate) => candidate.id === current.sourceModelRunId) : undefined;
    return {
      id: row.id,
      utteranceId: row.utteranceId,
      type: row.type,
      status: row.status,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      revisionCount: counts.find((entry) => entry.transcriptId === row.id)?.total ?? 0,
      currentRevision: current ? toRevisionView(current) : null,
      modelRun: run ? { ...run, finishedAt: toIso(run.finishedAt) } : null,
    };
  });
}

export async function buildTranscriptView(db: DbOrTx, row: TranscriptRow): Promise<transcriptSchemas.TranscriptView> {
  const [view] = await buildTranscriptViews(db, [row]);
  if (!view) throw new AppError("INTERNAL_ERROR", "The transcript could not be read.");
  return view;
}

export function isHumanTranscriptType(type: TranscriptType): type is transcriptSchemas.HumanTranscriptType {
  return (transcriptSchemas.HUMAN_TRANSCRIPT_TYPES as readonly string[]).includes(type);
}
