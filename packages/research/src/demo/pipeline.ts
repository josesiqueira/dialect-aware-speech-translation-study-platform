// The synchronous pipeline shared by Demo Mode, the admin pipeline test and the
// sample TEST sessions of the development seed (spec 52, 80, 143, 144, 163).
//
// It runs the same step functions as the job handlers, one after the other, in
// the request: ASR, then one translation per condition, then one synthesis per
// translation. Every step writes its model_runs row and its output row, so the
// provenance is the same as for a research batch. The stages are independent: a
// failed stage is reported with a message that is safe to show, and what
// succeeded before it is kept and returned.
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { MOCK_PROVIDER, isAiProviderError } from "@dialect/ai";
import {
  isUniqueViolation,
  modelRuns,
  processingBatches,
  transcriptRevisions,
  translations,
  type BatchConfigurationSnapshot,
  type ModelConfigSnapshot,
} from "@dialect/db";
import {
  AppError,
  isAppError,
  type demoSchemas,
  type StudyMode,
  type TranscriptType,
} from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { sanitizeErrorMessage } from "../jobs/queue";
import {
  DEFAULT_ASR_CONFIG_KEY,
  DEFAULT_TRANSLATION_CONFIG_KEYS,
  DEFAULT_TTS_CONFIG_KEY,
  conditionKeyOf,
} from "../processing/batches";
import { loadActiveModelConfigSnapshot, loadModelConfigSnapshot, type StudyRow } from "../processing/config";
import {
  asrStepKey,
  runAsrStep,
  runSynthesisStep,
  runTranslationStep,
  synthesisStepKey,
  translationStepKey,
  type ModelRunRow,
} from "../processing/steps";
import { attemptLimitError, attemptsExhausted } from "./budget";
import { ensureMockPipelineConfigs } from "./mock-configs";

type PipelineStage = demoSchemas.PipelineStage;
type PipelineStageError = demoSchemas.PipelineStageError;
type PipelineConditionResult = demoSchemas.PipelineConditionResult;

// ---------------------------------------------------------------------------
// Which configurations a run uses
// ---------------------------------------------------------------------------

// "active": the active configurations with the standard keys (the default).
// "mock": the stored mock provider configurations (see mock-configs.ts).
// "explicit": configurations named by id. They must not be drafts.
export type PipelineConfigSelection =
  | { kind: "active" }
  | { kind: "mock" }
  | {
      kind: "explicit";
      asrModelConfigId: string;
      translationModelConfigIds: string[];
      ttsModelConfigId: string;
    };

export type ResolvedStageConfig = { snapshot: ModelConfigSnapshot; error: null } | { snapshot: null; error: AppError };

export type ResolvedCondition = {
  // Stable name of the column: "translation_default", "translation_preserve" or the configuration key.
  slot: string;
  conditionKey: string;
  label: string;
  config: ResolvedStageConfig;
};

export type ResolvedPipelineConfigs = {
  mode: "active" | "mock" | "explicit";
  asr: ResolvedStageConfig;
  conditions: ResolvedCondition[];
  tts: ResolvedStageConfig;
};

const SLOT_LABELS: Record<string, string> = {
  translation_default: "Default translation",
  translation_preserve: "Preserve variation",
};
const SLOT_CONDITIONS: Record<string, string> = {
  translation_default: "default",
  translation_preserve: "preservation",
};
const CONDITION_SLOTS: Record<string, string> = { default: "translation_default", preservation: "translation_preserve" };

async function attempt(load: () => Promise<ModelConfigSnapshot>): Promise<ResolvedStageConfig> {
  try {
    return { snapshot: await load(), error: null };
  } catch (error) {
    // A missing configuration is a result of the stage, not a crash (spec 143).
    if (isAppError(error) && (error.code === "CONFIGURATION_MISSING" || error.code === "NOT_FOUND")) {
      return { snapshot: null, error };
    }
    throw error;
  }
}

function found(snapshot: ModelConfigSnapshot): ResolvedStageConfig {
  return { snapshot, error: null };
}

// Finds the configurations of one run. A stage without a usable configuration
// gets an error instead of a snapshot. There is no fallback to another
// configuration, model or prompt (spec 143).
export async function resolvePipelineConfigs(
  ctx: ServiceContext,
  study: StudyRow,
  selection: PipelineConfigSelection = { kind: "active" },
): Promise<ResolvedPipelineConfigs> {
  if (selection.kind === "mock") {
    const mock = await ensureMockPipelineConfigs(ctx, study.id);
    return {
      mode: "mock",
      asr: found(mock.asr),
      conditions: [
        {
          slot: "translation_default",
          conditionKey: conditionKeyOf(mock.translationDefault),
          label: SLOT_LABELS.translation_default!,
          config: found(mock.translationDefault),
        },
        {
          slot: "translation_preserve",
          conditionKey: conditionKeyOf(mock.translationPreserve),
          label: SLOT_LABELS.translation_preserve!,
          config: found(mock.translationPreserve),
        },
      ],
      tts: found(mock.tts),
    };
  }

  if (selection.kind === "explicit") {
    const byId = (modelConfigId: string, stage: "asr" | "translation" | "tts") =>
      attempt(() => loadModelConfigSnapshot(ctx.db, { modelConfigId, studyId: study.id, stage, requireActive: false }));
    const conditions: ResolvedCondition[] = [];
    for (const id of selection.translationModelConfigIds) {
      const config = await byId(id, "translation");
      const conditionKey = config.snapshot ? conditionKeyOf(config.snapshot) : id;
      const slot = CONDITION_SLOTS[conditionKey] ?? config.snapshot?.key ?? id;
      if (conditions.some((existing) => existing.conditionKey === conditionKey)) {
        throw new AppError("VALIDATION_ERROR", `Two translation configurations have the condition "${conditionKey}".`, {
          conditionKey,
        });
      }
      conditions.push({ slot, conditionKey, label: SLOT_LABELS[slot] ?? `Condition: ${conditionKey}`, config });
    }
    return {
      mode: "explicit",
      asr: await byId(selection.asrModelConfigId, "asr"),
      conditions,
      tts: await byId(selection.ttsModelConfigId, "tts"),
    };
  }

  const active = (key: string, stage: "asr" | "translation" | "tts") =>
    attempt(() => loadActiveModelConfigSnapshot(ctx.db, { studyId: study.id, key, stage }));
  const conditions: ResolvedCondition[] = [];
  for (const key of DEFAULT_TRANSLATION_CONFIG_KEYS) {
    const config = await active(key, "translation");
    conditions.push({
      slot: key,
      conditionKey: config.snapshot ? conditionKeyOf(config.snapshot) : SLOT_CONDITIONS[key]!,
      label: SLOT_LABELS[key]!,
      config,
    });
  }
  return {
    mode: "active",
    asr: await active(DEFAULT_ASR_CONFIG_KEY, "asr"),
    conditions,
    tts: await active(DEFAULT_TTS_CONFIG_KEY, "tts"),
  };
}

export function usesMockProvider(configs: ResolvedPipelineConfigs): boolean {
  return [configs.asr, configs.tts, ...configs.conditions.map((condition) => condition.config)].some(
    (config) => config.snapshot?.provider === MOCK_PROVIDER,
  );
}

// ---------------------------------------------------------------------------
// The processing batch of a synchronous run
// ---------------------------------------------------------------------------

export type SyncBatch = { id: string; name: string };

function configSignature(snapshot: Pick<BatchConfigurationSnapshot, "asr" | "translations" | "tts">): string {
  return [
    snapshot.asr?.modelConfigId ?? "-",
    snapshot.translations.map((config) => config.modelConfigId).join(","),
    snapshot.tts.map((config) => config.modelConfigId).join(","),
  ].join("|");
}

// Returns the batch that holds the outputs of one demo or test session, creating
// it when needed. The batch has the data mode of the session and a frozen
// configuration snapshot like any other batch. It has no jobs: the steps run in
// the request. When the configurations differ from the snapshot of the session's
// latest batch (a configuration was activated between two recordings), a new
// batch is created, because a batch never changes its configuration (spec 28, 54).
export async function ensureSyncBatch(
  ctx: ServiceContext,
  input: {
    study: StudyRow;
    session: { id: string; participantCode: string; mode: StudyMode };
    // For example "demo" or "pipeline-test". The name is "<prefix>-<participant code>".
    namePrefix: string;
    description: string;
    configs: ResolvedPipelineConfigs;
    transcriptTypes?: TranscriptType[];
  },
): Promise<SyncBatch> {
  const { study, session } = input;
  if (session.mode === "research") {
    throw new AppError("INVALID_STATE", "The synchronous pipeline never runs on a research session.");
  }
  const sourceLanguage = study.settingsJson.sourceLanguage ?? "";
  const targetLanguage = study.settingsJson.targetLanguage ?? "";
  const snapshot: BatchConfigurationSnapshot = {
    selection: {
      mode: [session.mode],
      completedSessionsOnly: false,
      verifiedTranscriptsOnly: false,
      excludeFlagged: false,
      excludeExcluded: false,
      sessionIds: [session.id],
    },
    transcriptTypes: input.transcriptTypes ?? ["asr"],
    runAsr: true,
    asr: input.configs.asr.snapshot,
    translations: input.configs.conditions.flatMap((condition) =>
      condition.config.snapshot ? [condition.config.snapshot] : [],
    ),
    tts: input.configs.tts.snapshot ? [input.configs.tts.snapshot] : [],
    sourceLanguage,
    targetLanguage,
    // The recordings are added one at a time after the batch exists.
    utteranceIds: [],
  };
  const signature = configSignature(snapshot);
  const baseName = `${input.namePrefix}-${session.participantCode}`;

  for (let round = 0; round < 5; round += 1) {
    const existing = await ctx.db
      .select()
      .from(processingBatches)
      .where(
        and(
          eq(processingBatches.studyId, study.id),
          eq(processingBatches.dataMode, session.mode),
          or(eq(processingBatches.name, baseName), like(processingBatches.name, `${baseName}-%`)),
        ),
      );
    const same = existing.find((batch) => configSignature(batch.configurationSnapshotJson) === signature);
    if (same) return { id: same.id, name: same.name };

    const name = existing.length === 0 ? baseName : `${baseName}-${existing.length + 1}`;
    const now = ctx.now();
    try {
      return await ctx.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(processingBatches)
          .values({
            studyId: study.id,
            name,
            description: input.description,
            // The steps run in the request, so the batch is running from the start.
            status: "running",
            dataMode: session.mode,
            startedAt: now,
            configurationSnapshotJson: snapshot,
            createdByLabel: ctx.actorLabel,
          })
          .returning({ id: processingBatches.id, name: processingBatches.name });
        if (!created) throw new AppError("DATABASE_ERROR", "The processing batch could not be created.");
        await recordAudit(tx, {
          action: "batch.create",
          entityType: "processing_batch",
          entityId: created.id,
          after: { name, dataMode: session.mode, sessionId: session.id, synchronous: true },
          actorLabel: ctx.actorLabel,
        });
        return created;
      });
    } catch (error) {
      // A second request of the same session created the batch first: look again.
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new AppError("CONFLICT", "The processing batch of this session could not be created. Please try again.");
}

// ---------------------------------------------------------------------------
// Errors that are safe to show
// ---------------------------------------------------------------------------

const STAGE_NAMES = { asr: "transcription", translation: "translation", tts: "speech synthesis" } as const;
type StageName = keyof typeof STAGE_NAMES;

// Turns anything a stage threw into a message that can be shown to a seminar
// audience: no provider internals, no stack trace, no key material. The cleaned
// provider message is added as `detail` only when the caller is an admin.
export function toStageError(
  ctx: ServiceContext,
  error: unknown,
  stage: StageName,
  options: { includeDetail: boolean; provider?: string | null },
): PipelineStageError {
  const what = STAGE_NAMES[stage];
  if (isAiProviderError(error)) {
    return {
      code: error.code,
      reason: "provider_error",
      message: error.retryable
        ? `The ${what} service did not answer correctly. Please try again in a moment.`
        : `The ${what} service rejected the request. The model configuration on the AI Pipeline page may need to be changed.`,
      retryable: error.retryable,
      ...(options.includeDetail ? { detail: sanitizeErrorMessage(error.message) } : {}),
    };
  }
  if (isAppError(error)) {
    if (error.code === "CONFIGURATION_MISSING") {
      const provider = (error.details as { provider?: unknown } | undefined)?.provider ?? null;
      if (typeof provider === "string") {
        // The provider of the configuration has no credentials on this server.
        return {
          code: error.code,
          reason: "provider_not_configured",
          message:
            provider === "openai"
              ? "The OpenAI API key is not configured on the server. An administrator sets OPENAI_API_KEY in the server environment and restarts the app. The AI Pipeline page shows whether the key is present."
              : `The AI provider "${provider}" is not configured on the server. The AI Pipeline page shows which providers are available.`,
          retryable: false,
        };
      }
      return { code: error.code, reason: "configuration_missing", message: error.message, retryable: false };
    }
    if (error.code === "STORAGE_ERROR" || error.code === "UPLOAD_FAILED") {
      return {
        code: error.code,
        reason: "storage",
        message: `The ${what} result could not be written to audio storage.`,
        ...(options.includeDetail ? { detail: sanitizeErrorMessage(error.message) } : {}),
      };
    }
    if (error.code === "INTERNAL_ERROR" || error.code === "DATABASE_ERROR") {
      return { code: error.code, reason: "other", message: `The ${what} step failed on the server. Please try again.` };
    }
    // Validation and state errors of the steps carry messages written for people.
    return { code: error.code, reason: "other", message: sanitizeErrorMessage(error.message), retryable: false };
  }
  ctx.logger.error(
    { stage, errorName: error instanceof Error ? error.name : "value" },
    "a synchronous pipeline stage failed with an unexpected error",
  );
  return { code: "INTERNAL_ERROR", reason: "other", message: `The ${what} step failed on the server. Please try again.` };
}

// ---------------------------------------------------------------------------
// Running the stages
// ---------------------------------------------------------------------------

function provenanceOf(snapshot: ModelConfigSnapshot, run: ModelRunRow | null): demoSchemas.PipelineStageProvenance {
  return {
    modelRunId: run?.id ?? null,
    modelConfigId: snapshot.modelConfigId,
    configKey: snapshot.key,
    configVersionNumber: snapshot.versionNumber,
    provider: snapshot.provider,
    requestedModel: snapshot.modelId,
    returnedModel: run?.returnedModel ?? null,
    promptKey: snapshot.promptKey,
    promptVersionNumber: snapshot.promptVersionNumber,
    latencyMs: run?.latencyMs ?? null,
  };
}

const NOT_RUN: PipelineStage = { status: "skipped", durationMs: null, error: null, provenance: null };

function failed(
  error: PipelineStageError,
  durationMs: number | null,
  snapshot: ModelConfigSnapshot | null,
): PipelineStage {
  return { status: "failed", durationMs, error, provenance: snapshot ? provenanceOf(snapshot, null) : null };
}

function elapsedSince(startedMs: number): number {
  return Math.max(0, Math.round(performance.now() - startedMs));
}

export type PipelineRunResult = {
  processingBatchId: string | null;
  batchName: string | null;
  asr: demoSchemas.DemoResult["asr"];
  conditions: PipelineConditionResult[];
  ok: boolean;
  totalDurationMs: number;
};

// Which part of the pipeline one call runs. The demo page asks for the stages
// one after the other, so each result is shown as soon as it exists. The steps
// are idempotent, so a later call finds the output of an earlier one and never
// repeats a model call that succeeded.
// - "all": ASR, translations and syntheses in one call.
// - "asr": the transcription only.
// - "translation": the translations of the stored ASR transcript. ASR is not run.
// - "tts": the syntheses of the stored translations. Nothing else is run.
export type PipelineStageSelection = "all" | "asr" | "translation" | "tts";

export type RunPipelineInput = {
  stage?: PipelineStageSelection;
  study: StudyRow;
  session: { id: string; participantCode: string; mode: StudyMode };
  utteranceId: string;
  configs: ResolvedPipelineConfigs;
  batchNamePrefix: string;
  batchDescription: string;
  // True when the caller is an admin: the cleaned provider message is included.
  includeDetail: boolean;
  // Demo Mode: a step that failed this many times (and never succeeded) is not
  // called again. Each attempt is a paid provider call. Not set: no limit.
  maxAttemptsPerStep?: number;
};

// Runs ASR, the translations of the ASR transcript and their syntheses for one
// utterance of a demo or test session. Never throws for a failed stage.
export async function runPipelineForUtterance(ctx: ServiceContext, input: RunPipelineInput): Promise<PipelineRunResult> {
  const started = performance.now();
  const { study, session, configs } = input;
  const detail = { includeDetail: input.includeDetail };

  const skippedConditions = (): PipelineConditionResult[] =>
    configs.conditions.map((condition) => ({
      conditionKey: condition.conditionKey,
      label: condition.label,
      translation: { ...NOT_RUN, translationId: null, text: null },
      synthesis: { ...NOT_RUN, synthesisId: null, mediaAssetId: null, mimeType: null, voiceKey: null },
    }));

  // --- ASR ---
  if (!configs.asr.snapshot) {
    return {
      processingBatchId: null,
      batchName: null,
      asr: {
        ...failed(toStageError(ctx, configs.asr.error, "asr", detail), null, null),
        transcriptRevisionId: null,
        text: null,
      },
      conditions: skippedConditions(),
      ok: false,
      totalDurationMs: elapsedSince(started),
    };
  }
  const asrConfig = configs.asr.snapshot;
  const batch = await ensureSyncBatch(ctx, {
    study,
    session,
    namePrefix: input.batchNamePrefix,
    description: input.batchDescription,
    configs,
  });

  const stageSelection = input.stage ?? "all";
  const maxAttempts = input.maxAttemptsPerStep;
  const exhausted = async (baseKey: string): Promise<boolean> =>
    maxAttempts !== undefined && (await attemptsExhausted(ctx, baseKey, maxAttempts));
  let asr: PipelineRunResult["asr"];
  const asrKey = asrStepKey({
    utteranceId: input.utteranceId,
    modelConfigId: asrConfig.modelConfigId,
    processingBatchId: batch.id,
  });
  if ((stageSelection === "all" || stageSelection === "asr") && (await exhausted(asrKey))) {
    asr = {
      ...failed(attemptLimitError("transcription", maxAttempts!), null, asrConfig),
      transcriptRevisionId: null,
      text: null,
    };
  } else if (stageSelection === "all" || stageSelection === "asr") {
    const asrStarted = performance.now();
    try {
      const step = await runAsrStep(ctx, {
        utteranceId: input.utteranceId,
        modelConfig: asrConfig,
        processingBatchId: batch.id,
        idempotencyKey: asrStepKey({
          utteranceId: input.utteranceId,
          modelConfigId: asrConfig.modelConfigId,
          processingBatchId: batch.id,
        }),
      });
      asr = {
        status: "succeeded",
        durationMs: elapsedSince(asrStarted),
        error: null,
        provenance: provenanceOf(asrConfig, step.modelRun),
        transcriptRevisionId: step.revision.id,
        text: step.revision.text,
      };
    } catch (error) {
      asr = {
        ...failed(toStageError(ctx, error, "asr", detail), elapsedSince(asrStarted), asrConfig),
        transcriptRevisionId: null,
        text: null,
      };
    }
  } else {
    // A later stage works on the transcript that the ASR stage stored. It never
    // starts a new transcription.
    const [existing] = await ctx.db
      .select({ run: modelRuns, revision: transcriptRevisions })
      .from(modelRuns)
      .innerJoin(transcriptRevisions, eq(transcriptRevisions.sourceModelRunId, modelRuns.id))
      .where(
        and(
          eq(modelRuns.stage, "asr"),
          eq(modelRuns.status, "succeeded"),
          eq(modelRuns.sourceEntityId, input.utteranceId),
          eq(modelRuns.processingBatchId, batch.id),
          eq(modelRuns.modelConfigId, asrConfig.modelConfigId),
        ),
      )
      .orderBy(desc(modelRuns.startedAt))
      .limit(1);
    asr = existing
      ? {
          status: "succeeded",
          durationMs: null,
          error: null,
          provenance: provenanceOf(asrConfig, existing.run),
          transcriptRevisionId: existing.revision.id,
          text: existing.revision.text,
        }
      : {
          ...failed(
            {
              code: "INVALID_STATE",
              reason: "no_transcript",
              message: "This recording has no transcript yet. The transcription has to succeed first.",
              retryable: false,
            },
            null,
            asrConfig,
          ),
          transcriptRevisionId: null,
          text: null,
        };
  }

  // --- Translation and synthesis, one chain per condition, side by side ---
  let conditions: PipelineConditionResult[];
  if (asr.status !== "succeeded" || !asr.transcriptRevisionId || stageSelection === "asr") {
    conditions = skippedConditions();
  } else {
    const revisionId = asr.transcriptRevisionId;
    const transcriptIsEmpty = (asr.text ?? "").trim().length === 0;
    conditions = await Promise.all(
      configs.conditions.map(async (condition): Promise<PipelineConditionResult> => {
        const result: PipelineConditionResult = {
          conditionKey: condition.conditionKey,
          label: condition.label,
          translation: { ...NOT_RUN, translationId: null, text: null },
          synthesis: { ...NOT_RUN, synthesisId: null, mediaAssetId: null, mimeType: null, voiceKey: null },
        };
        const translationConfig = condition.config.snapshot;
        if (!translationConfig) {
          result.translation = {
            ...failed(toStageError(ctx, condition.config.error, "translation", detail), null, null),
            translationId: null,
            text: null,
          };
          return result;
        }
        if (stageSelection === "tts") {
          // Only what was translated is synthesized. A translation that failed
          // in the translation stage is not tried again here.
          const [stored] = await ctx.db
            .select({ id: translations.id })
            .from(translations)
            .where(
              and(
                eq(translations.sourceTranscriptRevisionId, revisionId),
                eq(translations.conditionKey, condition.conditionKey),
                eq(translations.processingBatchId, batch.id),
                eq(translations.repetitionIndex, 0),
              ),
            )
            .limit(1);
          if (!stored) return result;
        }
        if (transcriptIsEmpty) {
          result.translation = {
            ...failed(
              {
                code: "VALIDATION_ERROR",
                reason: "empty_transcript",
                message: "The transcript is empty, so there is nothing to translate.",
                retryable: false,
              },
              null,
              translationConfig,
            ),
            translationId: null,
            text: null,
          };
          return result;
        }
        if (!study.settingsJson.sourceLanguage || !study.settingsJson.targetLanguage) {
          result.translation = {
            ...failed(
              {
                code: "CONFIGURATION_MISSING",
                reason: "configuration_missing",
                message: "The study settings do not name the source and target language. Set them on the Settings page.",
                retryable: false,
              },
              null,
              translationConfig,
            ),
            translationId: null,
            text: null,
          };
          return result;
        }

        const translationKey = translationStepKey({
          sourceTranscriptRevisionId: revisionId,
          conditionKey: condition.conditionKey,
          modelConfigId: translationConfig.modelConfigId,
          processingBatchId: batch.id,
        });
        if (await exhausted(translationKey)) {
          result.translation = {
            ...failed(attemptLimitError("translation", maxAttempts!), null, translationConfig),
            translationId: null,
            text: null,
          };
          return result;
        }
        const translationStarted = performance.now();
        let translationId: string;
        try {
          const step = await runTranslationStep(ctx, {
            sourceTranscriptRevisionId: revisionId,
            modelConfig: translationConfig,
            conditionKey: condition.conditionKey,
            processingBatchId: batch.id,
            idempotencyKey: translationStepKey({
              sourceTranscriptRevisionId: revisionId,
              conditionKey: condition.conditionKey,
              modelConfigId: translationConfig.modelConfigId,
              processingBatchId: batch.id,
            }),
            sourceLanguage: study.settingsJson.sourceLanguage,
            targetLanguage: study.settingsJson.targetLanguage,
            expectedUtteranceId: input.utteranceId,
          });
          translationId = step.translation.id;
          result.translation = {
            status: "succeeded",
            durationMs: elapsedSince(translationStarted),
            error: null,
            provenance: provenanceOf(translationConfig, step.modelRun),
            translationId,
            text: step.translation.translatedText,
          };
        } catch (error) {
          result.translation = {
            ...failed(
              toStageError(ctx, error, "translation", detail),
              elapsedSince(translationStarted),
              translationConfig,
            ),
            translationId: null,
            text: null,
          };
          return result;
        }

        if (stageSelection === "translation") return result;

        const ttsConfig = configs.tts.snapshot;
        if (!ttsConfig) {
          result.synthesis = {
            ...failed(toStageError(ctx, configs.tts.error, "tts", detail), null, null),
            synthesisId: null,
            mediaAssetId: null,
            mimeType: null,
            voiceKey: null,
          };
          return result;
        }
        const synthesisKey = synthesisStepKey({
          translationId,
          conditionKey: condition.conditionKey,
          modelConfigId: ttsConfig.modelConfigId,
          processingBatchId: batch.id,
        });
        if (await exhausted(synthesisKey)) {
          result.synthesis = {
            ...failed(attemptLimitError("speech synthesis", maxAttempts!), null, ttsConfig),
            synthesisId: null,
            mediaAssetId: null,
            mimeType: null,
            voiceKey: null,
          };
          return result;
        }
        const ttsStarted = performance.now();
        try {
          const step = await runSynthesisStep(ctx, {
            translationId,
            modelConfig: ttsConfig,
            // The synthesis carries the condition of its translation. The TTS
            // configuration is the same for every condition (spec 22).
            conditionKey: condition.conditionKey,
            processingBatchId: batch.id,
            idempotencyKey: synthesisStepKey({
              translationId,
              conditionKey: condition.conditionKey,
              modelConfigId: ttsConfig.modelConfigId,
              processingBatchId: batch.id,
            }),
          });
          result.synthesis = {
            status: "succeeded",
            durationMs: elapsedSince(ttsStarted),
            error: null,
            provenance: provenanceOf(ttsConfig, step.modelRun),
            synthesisId: step.synthesis.id,
            mediaAssetId: step.mediaAsset.id,
            mimeType: step.mediaAsset.mimeType,
            voiceKey: step.synthesis.voiceKey,
          };
        } catch (error) {
          result.synthesis = {
            ...failed(toStageError(ctx, error, "tts", detail), elapsedSince(ttsStarted), ttsConfig),
            synthesisId: null,
            mediaAssetId: null,
            mimeType: null,
            voiceKey: null,
          };
        }
        return result;
      }),
    );
  }

  // Whether the stages that this call ran succeeded.
  const translated = conditions.filter((condition) => condition.translation.status === "succeeded");
  let ok: boolean;
  if (stageSelection === "asr") {
    ok = asr.status === "succeeded";
  } else if (stageSelection === "translation") {
    ok = conditions.length > 0 && translated.length === conditions.length;
  } else if (stageSelection === "tts") {
    ok = translated.length > 0 && translated.every((condition) => condition.synthesis.status === "succeeded");
  } else {
    ok =
      asr.status === "succeeded" &&
      conditions.length > 0 &&
      conditions.every(
        (condition) => condition.translation.status === "succeeded" && condition.synthesis.status === "succeeded",
      );
  }
  const stageFailedNow = [asr, ...conditions.flatMap((condition) => [condition.translation, condition.synthesis])].some(
    (stage) => stage.status === "failed" && stage.error?.reason !== "no_transcript",
  );
  await markBatchFinished(ctx, batch.id, stageFailedNow);

  return {
    processingBatchId: batch.id,
    batchName: batch.name,
    asr,
    conditions,
    ok,
    totalDurationMs: elapsedSince(started),
  };
}

// A synchronous batch has no jobs, so its status is set here after each run:
// completed_with_errors while a piece of work has only failed attempts, or
// when the run that just ended had a stage that failed before any model call
// (a missing configuration, an empty transcript). Otherwise completed.
export async function markBatchFinished(ctx: ServiceContext, batchId: string, stageFailedNow: boolean): Promise<void> {
  const [batch] = await ctx.db
    .select({ status: processingBatches.status })
    .from(processingBatches)
    .where(eq(processingBatches.id, batchId))
    .limit(1);
  if (!batch || batch.status === "draft" || batch.status === "cancelled") return;
  const unresolved = await ctx.db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM (
      SELECT 1 FROM model_runs
      WHERE processing_batch_id = ${batchId}
      GROUP BY stage, source_entity_id, condition_key, model_config_id
      HAVING NOT bool_or(status = 'succeeded')
    ) AS work`);
  const hasErrors = stageFailedNow || Number(unresolved.rows[0]?.count ?? 0) > 0;
  await ctx.db
    .update(processingBatches)
    .set({ status: hasErrors ? "completed_with_errors" : "completed", completedAt: ctx.now() })
    .where(eq(processingBatches.id, batchId));
}
