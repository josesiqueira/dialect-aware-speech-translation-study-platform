// The admin pipeline smoke test (spec 52): storage write, ASR, default
// translation, preservation translation and TTS on one short test recording,
// each reported as PASS or FAIL. Everything it creates has mode `test`: a test
// session, a test batch, and their outputs. Test data is never part of a
// research export unless a researcher explicitly includes it.
import { desc, eq } from "drizzle-orm";
import { adminAuditLog, sessions as sessionsTable, type BrowserInfo, type ModelConfigSnapshot } from "@dialect/db";
import { AppError, demoSchemas, isAppError, type sessionSchemas } from "@dialect/domain";
import { generateSineWav } from "@dialect/storage";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import { createSession } from "../sessions/lifecycle";
import { resolveStudy } from "../sessions/settings";
import { mockProviderAvailable } from "./mock-configs";
import {
  resolvePipelineConfigs,
  runPipelineForUtterance,
  toStageError,
  usesMockProvider,
  type PipelineRunResult,
  type ResolvedPipelineConfigs,
} from "./pipeline";
import { storeSessionRecording, type StoredRecording } from "./recording";

type Row = demoSchemas.PipelineTestRow;
type RowKey = demoSchemas.PipelineTestRowKey;

export type PipelineTestAudio =
  | { kind: "generated_tone" }
  | {
      kind: "recording";
      data: Buffer;
      declaredMimeType?: string | null;
      captureMetadata?: sessionSchemas.CaptureMetadata | null;
    };

export type RunPipelineTestInput = {
  audio: PipelineTestAudio;
  // Default "active": the active configurations, exactly what a batch would use.
  provider?: demoSchemas.PipelineProviderMode;
  studySlug?: string;
};

// A 1.5 second 440 Hz tone, 16 kHz, 16 bit, mono. It lets the test run on a
// machine without a microphone. A real ASR model hears no speech in it.
export function generateTestTone(): Buffer {
  return generateSineWav({ durationMs: 1500, sampleRateHz: 16000, frequencyHz: 440 });
}

function modelLabel(snapshot: ModelConfigSnapshot | null): string | null {
  return snapshot ? `${snapshot.provider} / ${snapshot.modelId}` : null;
}

function row(key: RowKey, values: Omit<Row, "key" | "label">): Row {
  return { key, label: demoSchemas.PIPELINE_TEST_ROW_LABELS[key], ...values };
}

function stageRow(
  key: RowKey,
  stage: demoSchemas.PipelineStage,
  snapshot: ModelConfigSnapshot | null,
  notRunMessage: string,
): Row {
  if (stage.status === "succeeded") {
    return row(key, {
      result: "PASS",
      latencyMs: stage.provenance?.latencyMs ?? stage.durationMs,
      model: modelLabel(snapshot),
      message: null,
      errorCode: null,
    });
  }
  return row(key, {
    result: "FAIL",
    latencyMs: stage.durationMs,
    model: modelLabel(snapshot),
    message: stage.error
      ? stage.error.detail
        ? `${stage.error.message} (${stage.error.detail})`
        : stage.error.message
      : notRunMessage,
    errorCode: stage.error?.code ?? null,
  });
}

function buildRows(
  ctx: ServiceContext,
  configs: ResolvedPipelineConfigs,
  run: PipelineRunResult | null,
  storage: { ok: boolean; latencyMs: number | null; message: string | null },
): Row[] {
  const condition = (slot: string) => configs.conditions.find((entry) => entry.slot === slot) ?? null;
  const conditionResult = (slot: string) => {
    const entry = condition(slot);
    return entry ? (run?.conditions.find((result) => result.conditionKey === entry.conditionKey) ?? null) : null;
  };
  const notStored = "Not run, because the test recording could not be stored.";
  const skipped: demoSchemas.PipelineStage = { status: "skipped", durationMs: null, error: null, provenance: null };

  const translationRow = (key: "translation_default" | "translation_preserve"): Row =>
    stageRow(
      key,
      conditionResult(key)?.translation ?? skipped,
      condition(key)?.config.snapshot ?? null,
      !storage.ok ? notStored : "Not run, because transcription did not succeed.",
    );

  // One TTS row for the synthesis of every translation. The TTS configuration
  // is the same for all conditions (spec 22).
  const syntheses = (run?.conditions ?? []).map((result) => result.synthesis);
  const failedSynthesis = syntheses.find((stage) => stage.status === "failed");
  const succeeded = syntheses.filter((stage) => stage.status === "succeeded");
  let tts: Row;
  if (failedSynthesis) {
    tts = stageRow("tts", failedSynthesis, configs.tts.snapshot, "");
  } else if (succeeded.length > 0) {
    const latencies = succeeded.map((stage) => stage.provenance?.latencyMs ?? stage.durationMs ?? 0);
    tts = row("tts", {
      result: "PASS",
      latencyMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      model: modelLabel(configs.tts.snapshot),
      message: null,
      errorCode: null,
    });
  } else if (!configs.tts.snapshot) {
    const error = toStageError(ctx, configs.tts.error, "tts", { includeDetail: true });
    tts = row("tts", { result: "FAIL", latencyMs: null, model: null, message: error.message, errorCode: error.code });
  } else {
    tts = row("tts", {
      result: "FAIL",
      latencyMs: null,
      model: modelLabel(configs.tts.snapshot),
      message: !storage.ok ? notStored : "Not run, because no translation was available to synthesize.",
      errorCode: null,
    });
  }

  return [
    stageRow("asr", run?.asr ?? skipped, configs.asr.snapshot, notStored),
    translationRow("translation_default"),
    translationRow("translation_preserve"),
    tts,
    row("storage", {
      result: storage.ok ? "PASS" : "FAIL",
      latencyMs: storage.latencyMs,
      model: `${ctx.storage.driver} storage`,
      message: storage.message,
      errorCode: storage.ok ? null : "STORAGE_ERROR",
    }),
  ];
}

const EXCERPT_LENGTH = 160;

// Runs the pipeline test. The caller must be a signed-in researcher: the route
// uses admin authentication, and the test session is created as an admin.
// A stage that fails gives a FAIL row with a safe message. Only an unusable
// test recording (invalid or too large audio) is thrown as an error.
export async function runPipelineTest(
  ctx: ServiceContext,
  input: RunPipelineTestInput,
): Promise<demoSchemas.PipelineTestResult> {
  const provider = input.provider ?? "active";
  const study = await resolveStudy(ctx.db, input.studySlug);
  if (provider === "mock" && !mockProviderAvailable(ctx)) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      "The mock AI provider is disabled on this server, so the pipeline test can only run with the active configurations.",
    );
  }
  const configs = await resolvePipelineConfigs(ctx, study, provider === "mock" ? { kind: "mock" } : { kind: "active" });
  const source: demoSchemas.PipelineTestSource = input.audio.kind === "generated_tone" ? "generated_tone" : "recording";

  const marker: BrowserInfo & { pipelineTest: { source: string; provider: string } } = {
    pipelineTest: { source, provider },
  };
  const created = await createSession(ctx, {
    mode: "test",
    callerIsAdmin: true,
    browserInfo: marker,
    studySlug: study.slug,
  });
  const session = created.session;

  let stored: StoredRecording | null = null;
  let storage: { ok: boolean; latencyMs: number | null; message: string | null };
  try {
    stored = await storeSessionRecording(
      ctx,
      session,
      input.audio.kind === "generated_tone"
        ? { data: generateTestTone(), declaredMimeType: "audio/wav", captureMetadata: null }
        : {
            data: input.audio.data,
            declaredMimeType: input.audio.declaredMimeType ?? null,
            captureMetadata: input.audio.captureMetadata ?? null,
          },
      {
        mode: "test",
        limits: {
          maxDurationSeconds: demoSchemas.PIPELINE_TEST_MAX_RECORDING_SECONDS,
          maxBytes: demoSchemas.PIPELINE_TEST_MAX_UPLOAD_BYTES,
        },
      },
    );
    storage = { ok: true, latencyMs: stored.storageWriteMs, message: null };
  } catch (error) {
    if (isAppError(error) && (error.code === "UPLOAD_FAILED" || error.code === "STORAGE_ERROR")) {
      storage = {
        ok: false,
        latencyMs: null,
        message: "The test recording could not be written to audio storage. Check the storage settings of the server.",
      };
    } else {
      // The recording itself is unusable. Nothing was stored: remove the empty
      // test session again and report the problem as an error.
      await ctx.db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));
      throw error;
    }
  }

  const run = stored
    ? await runPipelineForUtterance(ctx, {
        study,
        session,
        utteranceId: stored.utteranceId,
        configs,
        batchNamePrefix: "pipeline-test",
        batchDescription: `Admin pipeline test ${session.participantCode} (${provider} configurations). Processed in the request.`,
        includeDetail: true,
      })
    : null;

  const rows = buildRows(ctx, configs, run, storage);
  const text = run?.asr.text ?? null;
  const result: demoSchemas.PipelineTestResult = {
    ranAt: ctx.now().toISOString(),
    providerMode: provider,
    isMock: usesMockProvider(configs),
    source,
    passed: rows.every((entry) => entry.result === "PASS"),
    rows,
    sessionId: session.id,
    participantCode: session.participantCode,
    utteranceId: stored?.utteranceId ?? "",
    processingBatchId: run?.processingBatchId ?? null,
    dataMode: "test",
    transcriptExcerpt: text === null ? null : text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}...` : text,
  };

  await ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    // The test session is finished: it has no cookie and takes no further input.
    await tx
      .update(sessionsTable)
      .set({ status: "completed", completedAt: now, lastActivityAt: now, tokenHash: null, tokenExpiresAt: null })
      .where(eq(sessionsTable.id, session.id));
    await recordAudit(tx, {
      action: "pipeline_test.run",
      entityType: "session",
      entityId: session.id,
      // The audit log never holds transcript text.
      after: { ...result, transcriptExcerpt: null },
      actorLabel: ctx.actorLabel,
    });
  });

  return result;
}

// The result of the latest pipeline test, read from the audit log, so it is
// still shown after a page reload and after the test data was reset.
export async function getLastPipelineTest(ctx: ServiceContext): Promise<demoSchemas.PipelineTestResult | null> {
  const [entry] = await ctx.db
    .select({ after: adminAuditLog.afterJson })
    .from(adminAuditLog)
    .where(eq(adminAuditLog.action, "pipeline_test.run"))
    .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
    .limit(1);
  const value = entry?.after as Partial<demoSchemas.PipelineTestResult> | null | undefined;
  if (!value || !Array.isArray(value.rows) || typeof value.ranAt !== "string") return null;
  return value as demoSchemas.PipelineTestResult;
}
