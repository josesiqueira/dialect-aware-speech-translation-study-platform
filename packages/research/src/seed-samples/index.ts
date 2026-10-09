// Sample TEST sessions for the development seed (spec 91).
//
// The sessions are created by driving the real services, the same way a
// participant and a researcher would: session creation (as an admin, mode
// `test`), consent, microphone check, instructions, every task with a generated
// sine tone as the recording, both questionnaires, completion. Two of the
// sessions then get human transcripts B and C with placeholder text and a small
// `test` batch that runs ASR, translation and TTS with the mock provider, so
// every admin page has something to show in development.
//
// Nothing here is research data, and nothing here is real participant data:
// the audio is a generated tone, the transcripts are marked placeholders, and
// the model outputs come from the mock provider.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  jobs,
  sessions as sessionsTable,
  utterances,
  type BrowserInfo,
  type ModelConfigSnapshot,
} from "@dialect/db";
import { AppError, type sessionSchemas } from "@dialect/domain";
import { generateSineWav } from "@dialect/storage";
import type { ServiceContext } from "../context";
import { ensureSyncBatch, markBatchFinished, resolvePipelineConfigs } from "../demo/pipeline";
import {
  asrStepKey,
  runAsrStep,
  runSynthesisStep,
  runTranslationStep,
  synthesisStepKey,
  translationStepKey,
} from "../processing/steps";
import {
  acknowledgeInstructions,
  completeSession,
  confirmMicCheck,
  createSession,
  recordConsent,
} from "../sessions/lifecycle";
import { participantSkipReview } from "../sessions/review-actions";
import { submitQuestionnaire } from "../sessions/questionnaires";
import { resolveStudy, type StudyRow } from "../sessions/settings";
import { createUtterance, startTask, submitUtterance, uploadUtteranceAudio } from "../sessions/tasks";
import { saveTranscriptRevision, verifyTranscript } from "../transcripts/revisions";

type ParticipantState = sessionSchemas.ParticipantState;
type QuestionnaireItem = sessionSchemas.QuestionnaireItemContent;

// Stored in sessions.browser_info_json.sampleSeed. A second run finds the
// sessions by this marker and creates nothing.
export const SAMPLE_SEED_MARKER = "sample-test-session";
const SAMPLE_LABEL = "sample-seed";
const DEFAULT_COUNT = 3;
// Sessions 1 and 2 get human transcripts and a mock batch. Later ones stay as collected.
const PROCESSED_SESSIONS = 2;
// The batch translates and synthesizes the first utterances only, to stay small.
const BATCH_UTTERANCE_LIMIT = 3;
const MAX_STEPS = 500;

type SampleBrowserInfo = BrowserInfo & { sampleSeed: { marker: string; index: number } };

export type SeededSampleSession = {
  index: number;
  sessionId: string;
  participantCode: string;
  utterances: number;
  humanTranscripts: number;
  translations: number;
  syntheses: number;
};

export type SeedSampleResult = {
  studyId: string;
  created: SeededSampleSession[];
  // Sample sessions that already existed and were left alone.
  existing: number;
};

// A plausible answer for one questionnaire item, chosen by its type. The index
// varies the choice between the sample sessions.
function sampleAnswer(item: QuestionnaireItem, index: number): unknown {
  const config = item.config;
  switch (item.type) {
    case "likert": {
      const min = config.scaleMin ?? 1;
      const max = config.scaleMax ?? 5;
      return min + ((index + item.itemKey.length) % (max - min + 1));
    }
    case "single_choice": {
      const options = config.options ?? [];
      return options.length > 0 ? options[index % options.length]!.value : undefined;
    }
    case "multi_choice": {
      const options = config.options ?? [];
      return options.length > 0 ? [options[index % options.length]!.value] : undefined;
    }
    case "integer": {
      const min = config.min ?? 0;
      const max = config.max ?? min + 10;
      return Math.min(max, min + index);
    }
    case "boolean":
      return index % 2 === 0;
    case "short_text":
    case "free_text": {
      const text = `[sample answer ${index}]`;
      return config.maxLength ? text.slice(0, config.maxLength) : text;
    }
    default:
      return undefined;
  }
}

function sampleAnswers(items: QuestionnaireItem[], index: number): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const item of items) {
    // Optional free text stays empty in every second session.
    if (!item.required && item.type === "free_text" && index % 2 === 0) continue;
    const value = sampleAnswer(item, index);
    if (value !== undefined) answers[item.itemKey] = value;
  }
  return answers;
}

// Walks one session through the whole participant flow with the real services.
async function collectSession(ctx: ServiceContext, study: StudyRow, index: number) {
  const marker: SampleBrowserInfo = {
    userAgent: "development seed (no browser)",
    sampleSeed: { marker: SAMPLE_SEED_MARKER, index },
  };
  const created = await createSession(ctx, {
    mode: "test",
    callerIsAdmin: true,
    studySlug: study.slug,
    // English, the base language of the seeded texts: the sample sessions keep
    // the texts the end-to-end tests and the admin examples refer to.
    locale: "en",
    browserInfo: marker,
  });
  const session = created.session;
  let state: ParticipantState = created.state;
  let recordings = 0;

  for (let step = 0; state.step !== "completed"; step += 1) {
    if (step > MAX_STEPS) throw new AppError("INTERNAL_ERROR", "The sample session did not reach its end.");
    switch (state.step) {
      case "consent":
        // The required items are accepted and the optional ones declined, so the
        // admin view shows both. The review is left out below with "Skip this part":
        // the sample sessions show the collected data, and nobody is there to rate outputs.
        state = await recordConsent(ctx, session, {
          responses: state.consent.items.map((item) => ({ itemId: item.id, accepted: item.required })),
        });
        break;
      // The sample sessions show the collected data; nobody rates outputs: skip the part.
      case "english_check":
      case "output_review":
        state = await participantSkipReview(ctx, session);
        break;
      case "mic_check":
        state = await confirmMicCheck(ctx, session, {
          audioEnvironment: { captureMethod: "generated_sine_wav", deviceLabel: "development seed (no microphone)" },
        });
        break;
      case "instructions":
        state = await acknowledgeInstructions(ctx, session);
        break;
      case "tasks": {
        const task = state.task;
        if (task.status === "pending") await startTask(ctx, session, task.presentationId);
        const { utteranceId } = await createUtterance(ctx, session, {
          presentationId: task.presentationId,
          turnIndex: task.turn.turnIndex,
        });
        recordings += 1;
        // A different tone per recording, a little longer than the task minimum.
        const seconds = Math.min(task.maxDurationSeconds, Math.max(2, (task.minDurationSeconds ?? 0) + 1));
        const data = generateSineWav({
          durationMs: seconds * 1000,
          sampleRateHz: 16000,
          frequencyHz: 180 + index * 40 + recordings * 15,
        });
        const upload = await uploadUtteranceAudio(ctx, session, {
          utteranceId,
          data,
          declaredMimeType: "audio/wav",
          captureMetadata: { userAgent: "development seed (generated sine tone)" },
        });
        state = await submitUtterance(ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId, attemptCount: 1 });
        break;
      }
      case "background":
        state = await submitQuestionnaire(ctx, session, {
          key: "background",
          answers: sampleAnswers(state.questionnaire.items, index),
        });
        break;
      case "post_recording":
        state = await submitQuestionnaire(ctx, session, {
          key: "post_recording",
          answers: sampleAnswers(state.questionnaire.items, index),
        });
        break;
      case "debrief":
        state = await completeSession(ctx, session);
        break;
      default:
        throw new AppError("INTERNAL_ERROR", `The sample session stopped at the step "${state.step}".`);
    }
  }

  const rows = await ctx.db
    .select({ id: utterances.id })
    .from(utterances)
    .where(and(eq(utterances.sessionId, session.id), eq(utterances.status, "submitted")))
    .orderBy(utterances.createdAt, utterances.turnIndex);

  // With the study setting autoQueueAsr on, each submission queued an ASR job
  // that would use the active configuration. The sample recordings are tones and
  // are transcribed below with the mock provider, so those jobs are cancelled
  // instead of spending a real model call on them.
  if (rows.length > 0) {
    await ctx.db
      .update(jobs)
      .set({ status: "cancelled", finishedAt: ctx.now(), lastError: "Cancelled by the development seed (sample session)." })
      .where(
        and(
          eq(jobs.status, "queued"),
          inArray(
            jobs.idempotencyKey,
            rows.map((row) => `asr:auto:${row.id}`),
          ),
        ),
      );
  }
  return { session, utteranceIds: rows.map((row) => row.id) };
}

// Adds placeholder human transcripts B and C to every utterance. `verified`
// marks both as verified, otherwise they stay drafts.
async function addHumanTranscripts(
  ctx: ServiceContext,
  utteranceIds: string[],
  verified: boolean,
): Promise<Array<{ utteranceId: string; revisionIds: string[] }>> {
  const result: Array<{ utteranceId: string; revisionIds: string[] }> = [];
  let number = 0;
  for (const utteranceId of utteranceIds) {
    number += 1;
    const b = await saveTranscriptRevision(ctx, {
      utteranceId,
      type: "human_dialect",
      text: `[sample B transcript ${number}]`,
      annotatorLabel: SAMPLE_LABEL,
    });
    const c = await saveTranscriptRevision(ctx, {
      utteranceId,
      type: "normalized",
      text: `[sample C transcript ${number}]`,
      annotatorLabel: SAMPLE_LABEL,
      derivedFromRevisionId: b.revision.id,
    });
    if (verified) {
      for (const saved of [b, c]) {
        await verifyTranscript(ctx, {
          transcriptId: saved.transcript.id,
          revisionId: saved.revision.id,
          verifiedByLabel: SAMPLE_LABEL,
          verificationNotes: "Placeholder text of the development seed.",
        });
      }
    }
    result.push({ utteranceId, revisionIds: [b.revision.id, c.revision.id] });
  }
  return result;
}

// Runs ASR for every utterance and, for the first utterances, both translation
// conditions and their syntheses on the ASR, B and C texts, with the mock
// provider configurations, in one `test` batch.
async function runMockBatch(
  ctx: ServiceContext,
  study: StudyRow,
  session: { id: string; participantCode: string },
  items: Array<{ utteranceId: string; revisionIds: string[] }>,
): Promise<{ translations: number; syntheses: number }> {
  const { sourceLanguage, targetLanguage } = study.settingsJson;
  if (!sourceLanguage || !targetLanguage) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      "The study settings do not name the source and target language, so the sample translations cannot be made.",
    );
  }
  const configs = await resolvePipelineConfigs(ctx, study, { kind: "mock" });
  const asrConfig = configs.asr.snapshot as ModelConfigSnapshot;
  const ttsConfig = configs.tts.snapshot as ModelConfigSnapshot;
  const batch = await ensureSyncBatch(ctx, {
    study,
    session: { ...session, mode: "test" },
    namePrefix: "sample",
    description: `Sample TEST session ${session.participantCode} of the development seed. Mock provider, not real model output.`,
    configs,
    transcriptTypes: ["asr", "human_dialect", "normalized"],
  });

  let translationCount = 0;
  let synthesisCount = 0;
  let position = 0;
  for (const item of items) {
    position += 1;
    const asr = await runAsrStep(ctx, {
      utteranceId: item.utteranceId,
      modelConfig: asrConfig,
      processingBatchId: batch.id,
      idempotencyKey: asrStepKey({
        utteranceId: item.utteranceId,
        modelConfigId: asrConfig.modelConfigId,
        processingBatchId: batch.id,
      }),
    });
    if (position > BATCH_UTTERANCE_LIMIT) continue;
    for (const revisionId of [asr.revision.id, ...item.revisionIds]) {
      for (const condition of configs.conditions) {
        const translationConfig = condition.config.snapshot as ModelConfigSnapshot;
        const translated = await runTranslationStep(ctx, {
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
          sourceLanguage,
          targetLanguage,
          expectedUtteranceId: item.utteranceId,
        });
        translationCount += 1;
        await runSynthesisStep(ctx, {
          translationId: translated.translation.id,
          modelConfig: ttsConfig,
          conditionKey: condition.conditionKey,
          processingBatchId: batch.id,
          idempotencyKey: synthesisStepKey({
            translationId: translated.translation.id,
            conditionKey: condition.conditionKey,
            modelConfigId: ttsConfig.modelConfigId,
            processingBatchId: batch.id,
          }),
        });
        synthesisCount += 1;
      }
    }
  }
  await markBatchFinished(ctx, batch.id, false);
  return { translations: translationCount, syntheses: synthesisCount };
}

// Creates the sample TEST sessions that do not exist yet. Running it again
// creates nothing. The context must carry an admin actor label, a storage
// adapter and a provider registry that allows the mock provider.
export async function seedSampleTestSessions(
  ctx: ServiceContext,
  input: { count?: number; studySlug?: string } = {},
): Promise<SeedSampleResult> {
  const count = input.count ?? DEFAULT_COUNT;
  const study = await resolveStudy(ctx.db, input.studySlug);
  const adminCtx: ServiceContext = { ...ctx, actorLabel: ctx.actorLabel ?? SAMPLE_LABEL };

  const existingRows = await ctx.db
    .select({ index: sql<string | null>`${sessionsTable.browserInfoJson}->'sampleSeed'->>'index'` })
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.studyId, study.id),
        eq(sessionsTable.mode, "test"),
        sql`${sessionsTable.browserInfoJson}->'sampleSeed'->>'marker' = ${SAMPLE_SEED_MARKER}`,
      ),
    );
  const existing = new Set(existingRows.map((row) => Number(row.index)));

  const created: SeededSampleSession[] = [];
  for (let index = 1; index <= count; index += 1) {
    if (existing.has(index)) continue;
    const collected = await collectSession(adminCtx, study, index);
    const summary: SeededSampleSession = {
      index,
      sessionId: collected.session.id,
      participantCode: collected.session.participantCode,
      utterances: collected.utteranceIds.length,
      humanTranscripts: 0,
      translations: 0,
      syntheses: 0,
    };
    if (index <= PROCESSED_SESSIONS) {
      // Session 1: verified transcripts. Session 2: drafts.
      const items = await addHumanTranscripts(adminCtx, collected.utteranceIds, index === 1);
      summary.humanTranscripts = items.length * 2;
      const outputs = await runMockBatch(adminCtx, study, collected.session, items);
      summary.translations = outputs.translations;
      summary.syntheses = outputs.syntheses;
    }
    created.push(summary);
  }
  return { studyId: study.id, created, existing: existing.size };
}
