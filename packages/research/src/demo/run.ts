// Demo Mode: run the pipeline on one demo recording (spec 80, 81, 163).
import { and, eq } from "drizzle-orm";
import { MOCK_PROVIDER } from "@dialect/ai";
import { mediaAssets, sessions as sessionsTable, utterances } from "@dialect/db";
import { AppError, type demoSchemas } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { asrStepKey } from "../processing/steps";
import { MAX_STEP_ATTEMPTS, consumeDemoRunBudget, stepAttempts } from "./budget";
import {
  ensureSyncBatch,
  resolvePipelineConfigs,
  runPipelineForUtterance,
  usesMockProvider,
  type PipelineConfigSelection,
  type PipelineStageSelection,
} from "./pipeline";
import { assertOpenDemoSession, demoSettings, loadStudyOfSession } from "./session";

const DEMO_BATCH_PREFIX = "demo";

function demoBatchDescription(participantCode: string): string {
  return `Demo Mode session ${participantCode}. Processed in the request, not by the worker.`;
}


export type RunDemoPipelineInput = {
  sessionId: string;
  utteranceId: string;
  // Default: the active configurations. `{ kind: "mock" }` and explicit ids are
  // for an admin only: the route decides who may pass them.
  configs?: PipelineConfigSelection;
  // Default "all". The demo page asks for "asr", "translation" and "tts" in
  // turn, so each result appears as soon as it exists.
  stage?: PipelineStageSelection;
  // True when the caller is an admin: stage errors then carry the cleaned
  // provider message as `detail`.
  isAdmin?: boolean;
};

// Runs ASR, both translation conditions and one synthesis per translation for
// one demo recording, in the request (near real time). All records are written
// through the processing step functions, in a batch whose data mode is `demo`.
// A failed stage is reported in the result. It never undoes an earlier stage.
//
// Cost limits (spec 67):
// - A visitor's first transcription of a recording takes one run from the daily
//   budget of the study (setting demoDailyRunLimit). When the budget is used up
//   the call is refused with RATE_LIMITED before any provider call. A signed-in
//   researcher and the mock provider are not counted.
// - Every step is tried at most MAX_STEP_ATTEMPTS times per recording.
export async function runDemoPipeline(ctx: ServiceContext, input: RunDemoPipelineInput): Promise<demoSchemas.DemoResult> {
  const [session] = await ctx.db.select().from(sessionsTable).where(eq(sessionsTable.id, input.sessionId)).limit(1);
  if (!session) throw new AppError("SESSION_EXPIRED", "The demo session was not found. Please start again.");
  assertOpenDemoSession(session);

  const [row] = await ctx.db
    .select({ utterance: utterances, asset: mediaAssets })
    .from(utterances)
    .innerJoin(mediaAssets, eq(mediaAssets.id, utterances.acceptedMediaAssetId))
    .where(and(eq(utterances.id, input.utteranceId), eq(utterances.sessionId, session.id)))
    .limit(1);
  // An utterance of another session is reported like one that does not exist.
  if (!row) throw new AppError("NOT_FOUND", "The demo recording was not found.");

  const study = await loadStudyOfSession(ctx, session);
  const configs = await resolvePipelineConfigs(ctx, study, input.configs ?? { kind: "active" });
  const stage = input.stage ?? "all";

  // Only the mock provider costs nothing. One configuration with a real
  // provider makes the run a paid run.
  const paidRun = [configs.asr, configs.tts, ...configs.conditions.map((condition) => condition.config)].some(
    (config) => config.snapshot !== null && config.snapshot.provider !== MOCK_PROVIDER,
  );
  if ((stage === "all" || stage === "asr") && input.isAdmin !== true && configs.asr.snapshot && paidRun) {
    // The run is counted once per recording: when no attempt exists yet. A retry
    // of a failed transcription is limited by MAX_STEP_ATTEMPTS instead.
    const batch = await ensureSyncBatch(ctx, {
      study,
      session,
      namePrefix: DEMO_BATCH_PREFIX,
      description: demoBatchDescription(session.participantCode),
      configs,
    });
    const baseKey = asrStepKey({
      utteranceId: row.utterance.id,
      modelConfigId: configs.asr.snapshot.modelConfigId,
      processingBatchId: batch.id,
    });
    if ((await stepAttempts(ctx, baseKey)).attempts === 0) {
      await consumeDemoRunBudget(ctx, { studyId: study.id, limit: demoSettings(study).demoDailyRunLimit });
    }
  }

  const run = await runPipelineForUtterance(ctx, {
    study,
    session,
    utteranceId: row.utterance.id,
    stage,
    configs,
    batchNamePrefix: DEMO_BATCH_PREFIX,
    batchDescription: demoBatchDescription(session.participantCode),
    includeDetail: input.isAdmin === true,
    maxAttemptsPerStep: MAX_STEP_ATTEMPTS,
  });

  await ctx.db.update(sessionsTable).set({ lastActivityAt: ctx.now() }).where(eq(sessionsTable.id, session.id));

  return {
    sessionId: session.id,
    participantCode: session.participantCode,
    utteranceId: row.utterance.id,
    turnIndex: row.utterance.turnIndex,
    dataMode: session.mode,
    processingBatchId: run.processingBatchId,
    batchName: run.batchName,
    providerMode: configs.mode,
    isMock: usesMockProvider(configs),
    source: {
      mediaAssetId: row.asset.id,
      mimeType: row.asset.mimeType,
      durationMs: row.asset.durationMs,
      sizeBytes: row.asset.sizeBytes,
      sha256: row.asset.sha256,
      captureQualityClass: (row.asset.captureQualityClass as demoSchemas.PipelineSourceInfo["captureQualityClass"]) ?? null,
    },
    asr: run.asr,
    conditions: run.conditions,
    ok: run.ok,
    totalDurationMs: run.totalDurationMs,
  };
}
