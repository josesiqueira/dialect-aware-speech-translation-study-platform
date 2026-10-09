// Read model: the complete lineage of one utterance (spec 106, 158, 169,
// Appendix C). One call answers, for any transcript, translation or TTS file of
// the utterance: which session, which source audio and hash, which task and
// exact prompt, which transcript condition and revision, which translation
// condition, prompt version, model and configuration, which processing batch,
// which exact translated text, which TTS model, configuration and voice, when it
// was generated and which app version produced the run.
//
// Used by the Session Detail page and by tests. Read-only.
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  aiPromptVersions,
  mediaAssets,
  modelConfigs,
  modelRuns,
  processingBatches,
  protocolTasks,
  sessions,
  syntheses,
  taskPresentations,
  transcriptRevisions,
  transcripts,
  translations,
  utterances,
  type MediaMetadata,
  type ModelParameters,
  type ModelRunInputManifest,
  type UtteranceQuality,
} from "@dialect/db";
import {
  AppError,
  TRANSCRIPT_TYPES,
  TRANSCRIPT_TYPE_LABELS,
  type BatchStatus,
  type MediaKind,
  type ModelRunStage,
  type ModelRunStatus,
  type OutputStatus,
  type ReviewStatus,
  type RevisionAuthorType,
  type SessionStatus,
  type StudyMode,
  type TaskType,
  type TranscriptType,
  type UtteranceStatus,
} from "@dialect/domain";
import type { ServiceContext } from "../context";

export type LineageMediaAsset = {
  id: string;
  kind: MediaKind;
  storageDriver: string;
  storageKey: string;
  mimeType: string;
  container: string | null;
  codec: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  bitDepth: number | null;
  durationMs: number | null;
  sizeBytes: number;
  sha256: string;
  captureMethod: string | null;
  captureQualityClass: string | null;
  derivedFromMediaAssetId: string | null;
  // Capture data (requested constraints, actual track settings) or derivation provenance.
  metadata: MediaMetadata;
  createdAt: Date;
  deletedAt: Date | null;
};

export type LineageModelRun = {
  id: string;
  stage: ModelRunStage;
  status: ModelRunStatus;
  attemptNumber: number;
  provider: string;
  requestedModel: string;
  returnedModel: string | null;
  providerRequestId: string | null;
  parameters: ModelParameters;
  inputManifest: ModelRunInputManifest;
  startedAt: Date;
  finishedAt: Date | null;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  // Observable response data of the run. For a failed run it holds, under
  // `failure`, what the provider answered: status, error code, a refusal, and a
  // partial or empty output text (spec 146).
  responseMetadata: Record<string, unknown> | null;
  appVersion: string;
  gitCommitSha: string | null;
  processingBatchId: string | null;
  conditionKey: string | null;
};

export type LineageModelConfig = {
  id: string;
  key: string;
  versionNumber: number;
  name: string | null;
  conditionKey: string | null;
  provider: string;
  modelId: string;
};

export type LineagePromptVersion = {
  id: string;
  key: string;
  versionNumber: number;
  name: string;
  promptText: string;
};

export type LineageBatchRef = {
  id: string;
  name: string;
  status: BatchStatus;
  dataMode: StudyMode;
  createdAt: Date;
  startedAt: Date | null;
};

// What produced an output: the run, the configuration and the prompt version.
export type LineageProvenance = {
  modelRun: LineageModelRun;
  modelConfig: LineageModelConfig | null;
  promptVersion: LineagePromptVersion | null;
};

export type LineageRevision = {
  id: string;
  revisionNumber: number;
  text: string;
  isCurrent: boolean;
  createdByType: RevisionAuthorType;
  createdByLabel: string | null;
  createdAt: Date;
  changeReason: string | null;
  transcriptionConventionVersion: string | null;
  derivedFromRevisionId: string | null;
  verifiedAt: Date | null;
  verifiedByLabel: string | null;
  hasSegments: boolean;
  // Set for a revision written by a model (ASR). Null for a human revision.
  provenance: LineageProvenance | null;
};

export type LineageTranscript = {
  id: string;
  type: TranscriptType;
  // A, A*, B or C.
  label: string;
  status: ReviewStatus;
  currentRevisionId: string | null;
  // Oldest first.
  revisions: LineageRevision[];
};

export type LineageSynthesis = {
  id: string;
  conditionKey: string;
  voiceKey: string;
  // The exact text that was synthesized.
  sourceText: string;
  repetitionIndex: number;
  status: OutputStatus;
  createdAt: Date;
  batch: LineageBatchRef;
  asset: LineageMediaAsset;
  provenance: LineageProvenance;
};

export type LineageTranslation = {
  id: string;
  conditionKey: string;
  // The exact raw model output.
  translatedText: string;
  targetLanguage: string;
  repetitionIndex: number;
  status: OutputStatus;
  createdAt: Date;
  source: {
    transcriptId: string;
    transcriptType: TranscriptType;
    transcriptLabel: string;
    transcriptRevisionId: string;
    revisionNumber: number;
  };
  provenance: LineageProvenance;
  syntheses: LineageSynthesis[];
};

export type UtteranceLineage = {
  utterance: {
    id: string;
    status: UtteranceStatus;
    turnIndex: number;
    attemptCount: number;
    // The exact prompt the participant answered (task prompt or follow-up).
    promptSnapshot: string;
    followupId: string | null;
    submittedAt: Date | null;
    durationMs: number | null;
    flagged: boolean;
    exclusionReason: string | null;
    quality: UtteranceQuality | null;
  };
  session: {
    id: string;
    participantCode: string;
    mode: StudyMode;
    status: SessionStatus;
    protocolVersionId: string;
    startedAt: Date;
    appVersion: string;
    flagged: boolean;
    excluded: boolean;
  };
  task: {
    taskPresentationId: string;
    protocolTaskId: string;
    taskKey: string;
    taskType: TaskType;
    sequenceIndex: number;
    titleSnapshot: string;
    promptSnapshot: string;
    contextSnapshot: string | null;
    instructionsSnapshot: string | null;
  };
  // The accepted recording. Null only for an utterance that was never submitted.
  sourceAsset: LineageMediaAsset | null;
  // Other audio of the utterance, for example the canonical WAV derived from a
  // compressed recording.
  relatedSourceAssets: LineageMediaAsset[];
  // In the order A, A*, B, C. Only transcript types that exist.
  transcripts: LineageTranscript[];
  // Translations grouped by processing batch, oldest batch first.
  batches: Array<{ batch: LineageBatchRef; translations: LineageTranslation[] }>;
  // Failed model runs on the utterance, its revisions or its translations.
  failedRuns: LineageModelRun[];
};

function toAsset(row: typeof mediaAssets.$inferSelect): LineageMediaAsset {
  return {
    id: row.id,
    kind: row.kind,
    storageDriver: row.storageDriver,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    container: row.container,
    codec: row.codec,
    sampleRateHz: row.sampleRateHz,
    channels: row.channels,
    bitDepth: row.bitDepth,
    durationMs: row.durationMs,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    captureMethod: row.captureMethod,
    captureQualityClass: row.captureQualityClass,
    derivedFromMediaAssetId: row.derivedFromMediaAssetId,
    metadata: row.metadataJson,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

function toRun(row: typeof modelRuns.$inferSelect): LineageModelRun {
  return {
    id: row.id,
    stage: row.stage,
    status: row.status,
    attemptNumber: row.attemptNumber,
    provider: row.provider,
    requestedModel: row.requestedModel,
    returnedModel: row.returnedModel,
    providerRequestId: row.providerRequestId,
    parameters: row.parametersJson,
    inputManifest: row.inputManifestJson,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    latencyMs: row.latencyMs,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    responseMetadata:
      row.responseMetadataJson !== null && typeof row.responseMetadataJson === "object"
        ? (row.responseMetadataJson as Record<string, unknown>)
        : null,
    appVersion: row.appVersion,
    gitCommitSha: row.gitCommitSha,
    processingBatchId: row.processingBatchId,
    conditionKey: row.conditionKey,
  };
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

export async function getUtteranceLineage(ctx: ServiceContext, utteranceId: string): Promise<UtteranceLineage> {
  const db = ctx.db;
  const [head] = await db
    .select({ utterance: utterances, session: sessions, presentation: taskPresentations, task: protocolTasks })
    .from(utterances)
    .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
    .innerJoin(taskPresentations, eq(taskPresentations.id, utterances.taskPresentationId))
    .innerJoin(protocolTasks, eq(protocolTasks.id, taskPresentations.protocolTaskId))
    .where(eq(utterances.id, utteranceId))
    .limit(1);
  if (!head) throw new AppError("NOT_FOUND", "Utterance not found.", { utteranceId });

  const utteranceAssets = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.utteranceId, utteranceId))
    .orderBy(asc(mediaAssets.createdAt));
  const transcriptRows = await db.select().from(transcripts).where(eq(transcripts.utteranceId, utteranceId));
  const transcriptIds = transcriptRows.map((row) => row.id);
  const revisionRows = transcriptIds.length
    ? await db
        .select()
        .from(transcriptRevisions)
        .where(inArray(transcriptRevisions.transcriptId, transcriptIds))
        .orderBy(asc(transcriptRevisions.revisionNumber))
    : [];
  const revisionIds = revisionRows.map((row) => row.id);
  const translationRows = revisionIds.length
    ? await db
        .select()
        .from(translations)
        .where(inArray(translations.sourceTranscriptRevisionId, revisionIds))
        .orderBy(asc(translations.createdAt), asc(translations.conditionKey), asc(translations.repetitionIndex))
    : [];
  const translationIds = translationRows.map((row) => row.id);
  const synthesisRows = translationIds.length
    ? await db
        .select()
        .from(syntheses)
        .where(inArray(syntheses.translationId, translationIds))
        .orderBy(asc(syntheses.createdAt), asc(syntheses.conditionKey), asc(syntheses.repetitionIndex))
    : [];
  const ttsAssetIds = unique(synthesisRows.map((row) => row.mediaAssetId));
  const ttsAssets = ttsAssetIds.length
    ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, ttsAssetIds))
    : [];

  const runIds = unique([
    ...revisionRows.map((row) => row.sourceModelRunId),
    ...translationRows.map((row) => row.modelRunId),
    ...synthesisRows.map((row) => row.modelRunId),
  ]);
  const outputRuns = runIds.length ? await db.select().from(modelRuns).where(inArray(modelRuns.id, runIds)) : [];
  const failedRunRows = await db
    .select()
    .from(modelRuns)
    .where(
      and(
        eq(modelRuns.status, "failed"),
        inArray(modelRuns.sourceEntityId, [utteranceId, ...revisionIds, ...translationIds]),
      ),
    )
    .orderBy(asc(modelRuns.startedAt), asc(modelRuns.attemptNumber));

  const configIds = unique(outputRuns.map((row) => row.modelConfigId));
  const configRows = configIds.length ? await db.select().from(modelConfigs).where(inArray(modelConfigs.id, configIds)) : [];
  const promptIds = unique(outputRuns.map((row) => row.promptVersionId));
  const promptRows = promptIds.length
    ? await db.select().from(aiPromptVersions).where(inArray(aiPromptVersions.id, promptIds))
    : [];
  const batchIds = unique([
    ...translationRows.map((row) => row.processingBatchId),
    ...synthesisRows.map((row) => row.processingBatchId),
  ]);
  const batchRows = batchIds.length
    ? await db
        .select()
        .from(processingBatches)
        .where(inArray(processingBatches.id, batchIds))
        .orderBy(asc(processingBatches.createdAt), asc(processingBatches.id))
    : [];

  const runsById = new Map(outputRuns.map((row) => [row.id, row]));
  const configsById = new Map(configRows.map((row) => [row.id, row]));
  const promptsById = new Map(promptRows.map((row) => [row.id, row]));
  const assetsById = new Map(ttsAssets.map((row) => [row.id, row]));
  const transcriptsById = new Map(transcriptRows.map((row) => [row.id, row]));
  const revisionsById = new Map(revisionRows.map((row) => [row.id, row]));
  const batchRefs = new Map<string, LineageBatchRef>(
    batchRows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        status: row.status,
        dataMode: row.dataMode,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
      },
    ]),
  );

  const provenanceOf = (modelRunId: string): LineageProvenance => {
    const run = runsById.get(modelRunId);
    if (!run) throw new AppError("INTERNAL_ERROR", "An output points at a model run that does not exist.", { modelRunId });
    const config = run.modelConfigId ? configsById.get(run.modelConfigId) : undefined;
    const prompt = run.promptVersionId ? promptsById.get(run.promptVersionId) : undefined;
    return {
      modelRun: toRun(run),
      modelConfig: config
        ? {
            id: config.id,
            key: config.key,
            versionNumber: config.versionNumber,
            name: config.name,
            conditionKey: config.conditionKey,
            provider: config.provider,
            modelId: config.modelId,
          }
        : null,
      promptVersion: prompt
        ? {
            id: prompt.id,
            key: prompt.key,
            versionNumber: prompt.versionNumber,
            name: prompt.name,
            promptText: prompt.promptText,
          }
        : null,
    };
  };
  const batchRefOf = (batchId: string): LineageBatchRef => {
    const ref = batchRefs.get(batchId);
    if (!ref) throw new AppError("INTERNAL_ERROR", "An output points at a batch that does not exist.", { batchId });
    return ref;
  };

  const lineageTranscripts: LineageTranscript[] = TRANSCRIPT_TYPES.flatMap((type) => {
    const transcript = transcriptRows.find((row) => row.type === type);
    if (!transcript) return [];
    const revisions = revisionRows
      .filter((row) => row.transcriptId === transcript.id)
      .map(
        (row): LineageRevision => ({
          id: row.id,
          revisionNumber: row.revisionNumber,
          text: row.text,
          isCurrent: row.isCurrent,
          createdByType: row.createdByType,
          createdByLabel: row.createdByLabel,
          createdAt: row.createdAt,
          changeReason: row.changeReason,
          transcriptionConventionVersion: row.transcriptionConventionVersion,
          derivedFromRevisionId: row.derivedFromRevisionId,
          verifiedAt: row.verifiedAt,
          verifiedByLabel: row.verifiedByLabel,
          hasSegments: row.segmentsJson !== null && row.segmentsJson !== undefined,
          provenance: row.sourceModelRunId ? provenanceOf(row.sourceModelRunId) : null,
        }),
      );
    return [
      {
        id: transcript.id,
        type,
        label: TRANSCRIPT_TYPE_LABELS[type],
        status: transcript.status,
        currentRevisionId: revisions.find((revision) => revision.isCurrent)?.id ?? null,
        revisions,
      },
    ];
  });

  const synthesesByTranslation = new Map<string, LineageSynthesis[]>();
  for (const row of synthesisRows) {
    if (!row.translationId) continue;
    const asset = assetsById.get(row.mediaAssetId);
    if (!asset) continue;
    const list = synthesesByTranslation.get(row.translationId) ?? [];
    list.push({
      id: row.id,
      conditionKey: row.conditionKey,
      voiceKey: row.voiceKey,
      sourceText: row.sourceText,
      repetitionIndex: row.repetitionIndex,
      status: row.status,
      createdAt: row.createdAt,
      batch: batchRefOf(row.processingBatchId),
      asset: toAsset(asset),
      provenance: provenanceOf(row.modelRunId),
    });
    synthesesByTranslation.set(row.translationId, list);
  }

  const typeOrder = new Map(TRANSCRIPT_TYPES.map((type, index) => [type, index]));
  const batches = batchRows
    .map((batchRow) => {
      const items = translationRows
        .filter((row) => row.processingBatchId === batchRow.id)
        .map((row): LineageTranslation => {
          const revision = revisionsById.get(row.sourceTranscriptRevisionId);
          const transcript = revision ? transcriptsById.get(revision.transcriptId) : undefined;
          if (!revision || !transcript) {
            throw new AppError("INTERNAL_ERROR", "A translation points at a revision that does not exist.");
          }
          return {
            id: row.id,
            conditionKey: row.conditionKey,
            translatedText: row.translatedText,
            targetLanguage: row.targetLanguage,
            repetitionIndex: row.repetitionIndex,
            status: row.status,
            createdAt: row.createdAt,
            source: {
              transcriptId: transcript.id,
              transcriptType: transcript.type,
              transcriptLabel: TRANSCRIPT_TYPE_LABELS[transcript.type],
              transcriptRevisionId: revision.id,
              revisionNumber: revision.revisionNumber,
            },
            provenance: provenanceOf(row.modelRunId),
            syntheses: synthesesByTranslation.get(row.id) ?? [],
          };
        })
        .sort(
          (a, b) =>
            (typeOrder.get(a.source.transcriptType) ?? 0) - (typeOrder.get(b.source.transcriptType) ?? 0) ||
            a.conditionKey.localeCompare(b.conditionKey) ||
            a.repetitionIndex - b.repetitionIndex,
        );
      return { batch: batchRefOf(batchRow.id), translations: items };
    })
    .filter((group) => group.translations.length > 0);

  const accepted = utteranceAssets.find((row) => row.id === head.utterance.acceptedMediaAssetId);
  return {
    utterance: {
      id: head.utterance.id,
      status: head.utterance.status,
      turnIndex: head.utterance.turnIndex,
      attemptCount: head.utterance.attemptCount,
      promptSnapshot: head.utterance.promptSnapshot,
      followupId: head.utterance.followupId,
      submittedAt: head.utterance.submittedAt,
      durationMs: head.utterance.durationMs,
      flagged: head.utterance.flagged,
      exclusionReason: head.utterance.exclusionReason,
      quality: head.utterance.qualityJson,
    },
    session: {
      id: head.session.id,
      participantCode: head.session.participantCode,
      mode: head.session.mode,
      status: head.session.status,
      protocolVersionId: head.session.protocolVersionId,
      startedAt: head.session.startedAt,
      appVersion: head.session.appVersion,
      flagged: head.session.flagged,
      excluded: head.session.excluded,
    },
    task: {
      taskPresentationId: head.presentation.id,
      protocolTaskId: head.task.id,
      taskKey: head.task.taskKey,
      taskType: head.task.taskType,
      sequenceIndex: head.presentation.sequenceIndex,
      titleSnapshot: head.presentation.titleSnapshot,
      promptSnapshot: head.presentation.promptSnapshot,
      contextSnapshot: head.presentation.contextSnapshot,
      instructionsSnapshot: head.presentation.instructionsSnapshot,
    },
    sourceAsset: accepted ? toAsset(accepted) : null,
    relatedSourceAssets: utteranceAssets.filter((row) => row.id !== accepted?.id).map(toAsset),
    transcripts: lineageTranscripts,
    batches,
    failedRuns: failedRunRows.map(toRun),
  };
}
