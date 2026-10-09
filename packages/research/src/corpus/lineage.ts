// Read queries for the transcripts, translations and syntheses of a set of
// utterances, with the provenance of every output (spec 45, 158, 169).
//
// Session Detail uses loadUtteranceLineages() for all utterances of a session
// in a fixed number of queries. The processing area has its own read model for
// one utterance (processing.getUtteranceLineage); the two are independent, and
// this file is the only place to change if Session Detail should switch to it.
import { asc, eq, inArray } from "drizzle-orm";
import {
  aiPromptVersions,
  mediaAssets,
  modelConfigs,
  modelRuns,
  processingBatches,
  syntheses,
  transcriptRevisions,
  transcripts,
  translations,
  type DbOrTx,
} from "@dialect/db";
import { TRANSCRIPT_TYPE_LABELS, type TranscriptType, type corpusSchemas } from "@dialect/domain";
import { TRANSCRIPT_ORDER, toIso, toMediaView, type ModelRunRow } from "./shared";

export type TranscriptRow = typeof transcripts.$inferSelect;
export type TranscriptRevisionRow = typeof transcriptRevisions.$inferSelect;
export type TranslationRow = typeof translations.$inferSelect;
export type SynthesisRow = typeof syntheses.$inferSelect;
export type BatchRow = typeof processingBatches.$inferSelect;

export type UtteranceLineage = {
  transcripts: corpusSchemas.TranscriptCellView[];
  translationBatches: corpusSchemas.TranslationBatchView[];
};

export type LineageData = {
  byUtterance: Map<string, UtteranceLineage>;
  // Raw rows, for the completeness checks and the id lists of Session Detail.
  transcripts: TranscriptRow[];
  revisions: TranscriptRevisionRow[];
  translations: TranslationRow[];
  syntheses: SynthesisRow[];
  batches: BatchRow[];
};

type ConfigRef = { id: string; key: string; versionNumber: number };

export type ModelRunLookup = {
  configs: Map<string, ConfigRef>;
  prompts: Map<string, ConfigRef>;
};

export async function loadModelRunLookup(db: DbOrTx, runs: ModelRunRow[]): Promise<ModelRunLookup> {
  const configIds = [...new Set(runs.map((run) => run.modelConfigId).filter((id): id is string => id !== null))];
  const promptIds = [...new Set(runs.map((run) => run.promptVersionId).filter((id): id is string => id !== null))];
  const configRows =
    configIds.length === 0
      ? []
      : await db
          .select({ id: modelConfigs.id, key: modelConfigs.key, versionNumber: modelConfigs.versionNumber })
          .from(modelConfigs)
          .where(inArray(modelConfigs.id, configIds));
  const promptRows =
    promptIds.length === 0
      ? []
      : await db
          .select({
            id: aiPromptVersions.id,
            key: aiPromptVersions.key,
            versionNumber: aiPromptVersions.versionNumber,
          })
          .from(aiPromptVersions)
          .where(inArray(aiPromptVersions.id, promptIds));
  return {
    configs: new Map(configRows.map((row) => [row.id, row])),
    prompts: new Map(promptRows.map((row) => [row.id, row])),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

// What a failed run kept from the provider, read from response_metadata_json
// (written by failRun in processing/steps.ts). Null for a run that did not fail.
export function toModelRunFailure(run: ModelRunRow): corpusSchemas.ModelRunFailureDetail | null {
  if (run.status !== "failed") return null;
  const metadata = record(run.responseMetadataJson);
  const failure = record(metadata.failure);
  const response = record(metadata.response);
  // A refused or cut-off answer carries `partialText`, an empty one `rawText`.
  const outputText = textOrNull(failure.partialText) ?? textOrNull(failure.rawText);
  return {
    providerStatus: typeof failure.providerStatus === "number" ? failure.providerStatus : null,
    providerErrorCode: textOrNull(failure.providerErrorCode),
    retryable: typeof failure.retryable === "boolean" ? failure.retryable : null,
    responseId: textOrNull(failure.responseId) ?? textOrNull(response.id),
    responseStatus: textOrNull(response.status),
    refusal: textOrNull(failure.refusal),
    outputText,
  };
}

export function toModelRunSummary(run: ModelRunRow, lookup: ModelRunLookup): corpusSchemas.ModelRunSummary {
  return {
    id: run.id,
    stage: run.stage,
    status: run.status,
    provider: run.provider,
    requestedModel: run.requestedModel,
    returnedModel: run.returnedModel,
    conditionKey: run.conditionKey,
    modelConfig: run.modelConfigId ? (lookup.configs.get(run.modelConfigId) ?? null) : null,
    prompt: run.promptVersionId ? (lookup.prompts.get(run.promptVersionId) ?? null) : null,
    processingBatchId: run.processingBatchId,
    parameters: run.parametersJson ?? {},
    attemptNumber: run.attemptNumber,
    startedAt: toIso(run.startedAt),
    finishedAt: toIso(run.finishedAt),
    latencyMs: run.latencyMs,
    providerRequestId: run.providerRequestId,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    failure: toModelRunFailure(run),
    appVersion: run.appVersion,
    gitCommitSha: run.gitCommitSha,
  };
}

export function toBatchSummary(batch: BatchRow): corpusSchemas.BatchSummary {
  return {
    id: batch.id,
    name: batch.name,
    status: batch.status,
    dataMode: batch.dataMode,
    createdAt: toIso(batch.createdAt),
    startedAt: toIso(batch.startedAt),
    completedAt: toIso(batch.completedAt),
  };
}

function group<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    if (value === null) continue;
    const list = map.get(value);
    if (list) list.push(row);
    else map.set(value, [row]);
  }
  return map;
}

export async function loadUtteranceLineages(db: DbOrTx, utteranceIds: string[]): Promise<LineageData> {
  const empty: LineageData = {
    byUtterance: new Map(),
    transcripts: [],
    revisions: [],
    translations: [],
    syntheses: [],
    batches: [],
  };
  if (utteranceIds.length === 0) return empty;

  const transcriptRows = await db.select().from(transcripts).where(inArray(transcripts.utteranceId, utteranceIds));
  const transcriptIds = transcriptRows.map((row) => row.id);
  const revisionRows =
    transcriptIds.length === 0
      ? []
      : await db
          .select()
          .from(transcriptRevisions)
          .where(inArray(transcriptRevisions.transcriptId, transcriptIds))
          .orderBy(asc(transcriptRevisions.revisionNumber));
  const revisionIds = revisionRows.map((row) => row.id);
  const translationRows =
    revisionIds.length === 0
      ? []
      : await db
          .select()
          .from(translations)
          .where(inArray(translations.sourceTranscriptRevisionId, revisionIds))
          .orderBy(asc(translations.createdAt), asc(translations.repetitionIndex));
  const translationIds = translationRows.map((row) => row.id);
  const synthesisRows =
    translationIds.length === 0
      ? []
      : await db
          .select()
          .from(syntheses)
          .where(inArray(syntheses.translationId, translationIds))
          .orderBy(asc(syntheses.createdAt), asc(syntheses.repetitionIndex));
  const mediaIds = [...new Set(synthesisRows.map((row) => row.mediaAssetId))];
  const mediaRows = mediaIds.length === 0 ? [] : await db.select().from(mediaAssets).where(inArray(mediaAssets.id, mediaIds));

  const runIds = [
    ...new Set([
      ...revisionRows.map((row) => row.sourceModelRunId).filter((id): id is string => id !== null),
      ...translationRows.map((row) => row.modelRunId),
      ...synthesisRows.map((row) => row.modelRunId),
    ]),
  ];
  const runRows = runIds.length === 0 ? [] : await db.select().from(modelRuns).where(inArray(modelRuns.id, runIds));
  const lookup = await loadModelRunLookup(db, runRows);
  const runs = new Map(runRows.map((row) => [row.id, toModelRunSummary(row, lookup)]));

  const batchIds = [
    ...new Set([...translationRows.map((row) => row.processingBatchId), ...synthesisRows.map((row) => row.processingBatchId)]),
  ];
  const batchRows =
    batchIds.length === 0
      ? []
      : await db
          .select()
          .from(processingBatches)
          .where(inArray(processingBatches.id, batchIds))
          .orderBy(asc(processingBatches.createdAt), asc(processingBatches.name));

  const media = new Map(mediaRows.map((row) => [row.id, toMediaView(row)]));
  const transcriptById = new Map(transcriptRows.map((row) => [row.id, row]));
  const revisionById = new Map(revisionRows.map((row) => [row.id, row]));
  const revisionsByTranscript = group(revisionRows, (row) => row.transcriptId);
  const synthesesByTranslation = group(synthesisRows, (row) => row.translationId);
  const transcriptsByUtterance = group(transcriptRows, (row) => row.utteranceId);

  const missingRun = (id: string): never => {
    throw new Error(`Model run ${id} of a stored output was not found`);
  };

  const toSynthesisView = (row: SynthesisRow): corpusSchemas.SynthesisView => {
    const asset = media.get(row.mediaAssetId);
    if (!asset) throw new Error(`Media asset ${row.mediaAssetId} of synthesis ${row.id} was not found`);
    return {
      id: row.id,
      conditionKey: row.conditionKey,
      voiceKey: row.voiceKey,
      status: row.status,
      repetitionIndex: row.repetitionIndex,
      createdAt: toIso(row.createdAt),
      sourceText: row.sourceText,
      media: asset,
      modelRun: runs.get(row.modelRunId) ?? missingRun(row.modelRunId),
    };
  };

  const toTranslationView = (row: TranslationRow): corpusSchemas.TranslationCellView => {
    const revision = revisionById.get(row.sourceTranscriptRevisionId);
    const transcript = revision ? transcriptById.get(revision.transcriptId) : undefined;
    if (!revision || !transcript) throw new Error(`Source revision of translation ${row.id} was not found`);
    return {
      id: row.id,
      conditionKey: row.conditionKey,
      text: row.translatedText,
      targetLanguage: row.targetLanguage,
      status: row.status,
      repetitionIndex: row.repetitionIndex,
      createdAt: toIso(row.createdAt),
      sourceRevision: {
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        isCurrent: revision.isCurrent,
        transcriptType: transcript.type,
      },
      modelRun: runs.get(row.modelRunId) ?? missingRun(row.modelRunId),
      syntheses: (synthesesByTranslation.get(row.id) ?? []).map(toSynthesisView),
    };
  };

  const byUtterance = new Map<string, UtteranceLineage>();
  for (const utteranceId of utteranceIds) {
    const own = transcriptsByUtterance.get(utteranceId) ?? [];

    const transcriptViews = TRANSCRIPT_ORDER.map((type): corpusSchemas.TranscriptCellView => {
      const transcript = own.find((row) => row.type === type);
      const revisions = transcript ? (revisionsByTranscript.get(transcript.id) ?? []) : [];
      const current = revisions.find((row) => row.isCurrent) ?? null;
      return {
        type,
        label: TRANSCRIPT_TYPE_LABELS[type],
        transcriptId: transcript?.id ?? null,
        status: transcript?.status ?? "not_started",
        revisionCount: revisions.length,
        current: current
          ? {
              id: current.id,
              revisionNumber: current.revisionNumber,
              text: current.text,
              createdByType: current.createdByType,
              createdByLabel: current.createdByLabel,
              createdAt: toIso(current.createdAt),
              verifiedAt: toIso(current.verifiedAt),
              verifiedByLabel: current.verifiedByLabel,
              transcriptionConventionVersion: current.transcriptionConventionVersion,
              modelRun: current.sourceModelRunId ? (runs.get(current.sourceModelRunId) ?? null) : null,
            }
          : null,
      };
    });

    const ownRevisionType = new Map<string, TranscriptType>();
    for (const transcript of own) {
      for (const revision of revisionsByTranscript.get(transcript.id) ?? []) {
        ownRevisionType.set(revision.id, transcript.type);
      }
    }
    const ownTranslations = translationRows.filter((row) => ownRevisionType.has(row.sourceTranscriptRevisionId));

    const translationBatches = batchRows
      .filter((batch) => ownTranslations.some((row) => row.processingBatchId === batch.id))
      .map((batch): corpusSchemas.TranslationBatchView => {
        const inBatch = ownTranslations.filter((row) => row.processingBatchId === batch.id);
        // Column order: the order of the batch configuration, then any other
        // condition that has an output.
        const configured = (batch.configurationSnapshotJson?.translations ?? [])
          .map((config) => config.conditionKey)
          .filter((key): key is string => typeof key === "string" && key !== "");
        const conditions = [...new Set([...configured, ...inBatch.map((row) => row.conditionKey).sort()])];
        return {
          batch: toBatchSummary(batch),
          conditions,
          rows: TRANSCRIPT_ORDER.map((type) => ({
            transcriptType: type,
            label: TRANSCRIPT_TYPE_LABELS[type],
            cells: conditions.map((conditionKey) => ({
              conditionKey,
              translations: inBatch
                .filter(
                  (row) =>
                    row.conditionKey === conditionKey && ownRevisionType.get(row.sourceTranscriptRevisionId) === type,
                )
                .map(toTranslationView),
            })),
          })),
        };
      });

    byUtterance.set(utteranceId, { transcripts: transcriptViews, translationBatches });
  }

  return {
    byUtterance,
    transcripts: transcriptRows,
    revisions: revisionRows,
    translations: translationRows,
    syntheses: synthesisRows,
    batches: batchRows,
  };
}

// Used by the media download name: the transcript type and condition behind a TTS file.
export async function loadSynthesisOrigin(
  db: DbOrTx,
  synthesisId: string,
): Promise<{
  synthesisId: string;
  ttsCondition: string;
  repetitionIndex: number;
  translationCondition: string | null;
  transcriptType: TranscriptType | null;
  utteranceId: string | null;
} | null> {
  const [row] = await db
    .select({
      synthesisId: syntheses.id,
      ttsCondition: syntheses.conditionKey,
      repetitionIndex: syntheses.repetitionIndex,
      translationCondition: translations.conditionKey,
      transcriptType: transcripts.type,
      utteranceId: transcripts.utteranceId,
    })
    .from(syntheses)
    .leftJoin(translations, eq(translations.id, syntheses.translationId))
    .leftJoin(transcriptRevisions, eq(transcriptRevisions.id, translations.sourceTranscriptRevisionId))
    .leftJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
    .where(eq(syntheses.id, synthesisId));
  return row ?? null;
}
