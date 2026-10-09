// Helpers for the session service tests. Not exported from the package index.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { studies, type ConsentItem, type Database, type StudySettings } from "@dialect/db";
import {
  DEFAULT_TEST_CONSENT_ITEMS,
  insertActiveAiConfigs,
  insertConsentVersion,
  insertPublishedProtocol,
  insertQuestionnaire,
  insertStudy,
  type ProtocolBundle,
  type ProtocolTaskInput,
  type QuestionnaireItemInput,
} from "@dialect/db/testing-builders";
import { CONSENT_SCOPE_EXTERNAL_AI_PROCESSING, CONSENT_SCOPE_OUTPUT_REVIEW, type sessionSchemas } from "@dialect/domain";
import { generateSineWav } from "@dialect/storage";
import type { ServiceContext } from "../context";
import {
  acknowledgeInstructions,
  confirmMicCheck,
  createSession,
  createUtterance,
  getParticipantState,
  recordConsent,
  startTask,
  submitUtterance,
  uploadUtteranceAudio,
  type CreatedSession,
  type SessionRef,
} from "./index";

export type ParticipantState = sessionSchemas.ParticipantState;
export type TasksState = Extract<ParticipantState, { step: "tasks" }>;

// The same shape as the seeded protocol: a shuffled block of controlled tasks,
// a semi-structured task with a required and an optional follow-up, a second
// semi-structured task without follow-ups, and a free speech task.
export const SEED_LIKE_TASKS: ProtocolTaskInput[] = [
  {
    taskKey: "controlled_a",
    taskType: "controlled",
    title: "Controlled A",
    participantPrompt: "Prompt of controlled task A.",
    blockKey: "controlled",
    orderMode: "shuffle_within_block",
    maxDurationSeconds: 120,
  },
  {
    taskKey: "controlled_b",
    taskType: "controlled",
    title: "Controlled B",
    participantPrompt: "Prompt of controlled task B.",
    contextText: "Context of controlled task B.",
    blockKey: "controlled",
    orderMode: "shuffle_within_block",
    maxDurationSeconds: 120,
  },
  {
    taskKey: "controlled_c",
    taskType: "controlled",
    title: "Controlled C",
    participantPrompt: "Prompt of controlled task C.",
    blockKey: "controlled",
    orderMode: "shuffle_within_block",
    maxDurationSeconds: 120,
  },
  {
    taskKey: "semi_a",
    taskType: "semi_structured",
    title: "Semi-structured A",
    participantPrompt: "Prompt of semi-structured task A.",
    blockKey: "semi_structured",
    maxDurationSeconds: 180,
    followups: [
      { followupKey: "required_followup", promptText: "Required follow-up prompt.", isRequired: true },
      { followupKey: "optional_followup", promptText: "Optional follow-up prompt.", isRequired: false },
      { followupKey: "disabled_followup", promptText: "Disabled follow-up prompt.", enabled: false },
    ],
  },
  {
    taskKey: "semi_b",
    taskType: "semi_structured",
    title: "Semi-structured B",
    participantPrompt: "Prompt of semi-structured task B.",
    blockKey: "semi_structured",
    maxDurationSeconds: 180,
  },
  {
    taskKey: "free_speech",
    taskType: "free_speech",
    title: "Free speech",
    participantPrompt: "Prompt of the free speech task.",
    instructionsText: "Aim for about one to two minutes.",
    blockKey: "free",
    suggestedDurationSeconds: 90,
    maxDurationSeconds: 300,
    privacyReminder: true,
    configJson: { topicSuggestions: ["Your weekend", "A place you like"] },
  },
  {
    taskKey: "disabled_task",
    taskType: "controlled",
    title: "Disabled task",
    participantPrompt: "Prompt of a disabled task.",
    blockKey: "controlled",
    orderMode: "shuffle_within_block",
    enabled: false,
  },
];

export const BACKGROUND_ITEMS: QuestionnaireItemInput[] = [
  {
    itemKey: "age_range",
    type: "single_choice",
    prompt: "What is your age range?",
    required: true,
    configJson: { options: [{ value: "18_24", label: "18 to 24" }, { value: "25_34", label: "25 to 34" }] },
  },
  { itemKey: "region", type: "short_text", prompt: "Where did you grow up?", required: true, configJson: { maxLength: 50 } },
  {
    itemKey: "languages",
    type: "multi_choice",
    prompt: "Which languages do you use?",
    required: false,
    configJson: { options: [{ value: "fi", label: "Finnish" }, { value: "sv", label: "Swedish" }] },
  },
  { itemKey: "years", type: "integer", prompt: "How many years did you live there?", required: false, configJson: { min: 0, max: 120 } },
  { itemKey: "moved", type: "boolean", prompt: "Have you moved?", required: false },
];

export const POST_ITEMS: QuestionnaireItemInput[] = [
  { itemKey: "naturalness", type: "likert", prompt: "How naturally did you speak?", required: true, configJson: { scaleMin: 1, scaleMax: 5 } },
  { itemKey: "comment", type: "free_text", prompt: "Any other comments?", required: false },
];

export const VALID_BACKGROUND_ANSWERS = { age_range: "25_34", region: "Kuopio", languages: ["fi"], years: 20, moved: true };
export const VALID_POST_ANSWERS = { naturalness: 4 };

// The default test consent items plus an optional item for external AI
// processing. Automatic transcription after an upload needs this item accepted.
export const CONSENT_ITEMS_WITH_EXTERNAL_AI: ConsentItem[] = [
  ...DEFAULT_TEST_CONSENT_ITEMS,
  {
    id: "external_ai_processing",
    text: "My recordings may be processed with external AI services.",
    required: false,
    scope: CONSENT_SCOPE_EXTERNAL_AI_PROCESSING,
  },
];

// Consent items for the output review: external AI processing and the review itself.
export const CONSENT_ITEMS_WITH_REVIEW: ConsentItem[] = [
  ...CONSENT_ITEMS_WITH_EXTERNAL_AI,
  {
    id: "output_review",
    text: "At the end I will see and rate the AI output of some of my recordings.",
    required: false,
    scope: CONSENT_SCOPE_OUTPUT_REVIEW,
  },
];

export const POST_REVIEW_ITEMS: QuestionnaireItemInput[] = [
  { itemKey: "overall_representation", type: "likert", prompt: "Overall, how well did the versions represent how you speak?", required: true, configJson: { scaleMin: 1, scaleMax: 5 } },
  { itemKey: "study_about", type: "free_text", prompt: "What do you think this study was about?", required: false },
];
export const VALID_POST_REVIEW_ANSWERS = { overall_representation: 3 };

export type TestStudy = ProtocolBundle & {
  consent: Awaited<ReturnType<typeof insertPublishedProtocol>>["consent"];
  study: Awaited<ReturnType<typeof insertStudy>>;
  slug: string;
  background: Awaited<ReturnType<typeof insertQuestionnaire>> | null;
  post: Awaited<ReturnType<typeof insertQuestionnaire>> | null;
  postReview: Awaited<ReturnType<typeof insertQuestionnaire>> | null;
};

export async function createTestStudy(
  db: Database,
  options: {
    settings?: StudySettings;
    tasks?: ProtocolTaskInput[];
    withBackground?: boolean;
    withPost?: boolean;
    // A post-review questionnaire (key post_review). Default: none.
    withPostReview?: boolean;
    // Consent items of the protocol. Default: the builder's items, without an
    // item for external AI processing. When the setting autoQueueAsr is on, the
    // default is CONSENT_ITEMS_WITH_EXTERNAL_AI.
    consentItems?: ConsentItem[];
    // Insert active AI configurations (mock provider), which include asr_default.
    // Default: true when the setting autoQueueAsr is on.
    aiConfigs?: boolean;
  } = {},
): Promise<TestStudy> {
  const study = await insertStudy(db, {
    settingsJson: { allowNewSessions: true, autoQueueAsr: false, ...options.settings },
  });
  const background =
    options.withBackground === false
      ? null
      : await insertQuestionnaire(db, { studyId: study.id, key: "background", items: BACKGROUND_ITEMS });
  const post =
    options.withPost === false
      ? null
      : await insertQuestionnaire(db, { studyId: study.id, key: "post_recording", items: POST_ITEMS });
  const postReview = options.withPostReview
    ? await insertQuestionnaire(db, { studyId: study.id, key: "post_review", items: POST_REVIEW_ITEMS })
    : null;
  const autoAsr = options.settings?.autoQueueAsr === true;
  const consentItems = options.consentItems ?? (autoAsr ? CONSENT_ITEMS_WITH_EXTERNAL_AI : undefined);
  const consentVersion = consentItems
    ? await insertConsentVersion(db, { studyId: study.id, itemsJson: consentItems })
    : null;
  if (options.aiConfigs ?? autoAsr) await insertActiveAiConfigs(db, { studyId: study.id });
  const bundle = await insertPublishedProtocol(db, {
    studyId: study.id,
    ...(consentVersion ? { consentVersionId: consentVersion.id } : {}),
    tasks: options.tasks ?? SEED_LIKE_TASKS,
    backgroundQuestionnaireVersionId: background?.version.id ?? null,
    postQuestionnaireVersionId: post?.version.id ?? null,
    postReviewQuestionnaireVersionId: postReview?.version.id ?? null,
  });
  return { ...bundle, study, slug: study.slug, background, post, postReview };
}

export async function updateSettings(db: Database, studyId: string, settings: StudySettings): Promise<void> {
  const [study] = await db.select().from(studies).where(eq(studies.id, studyId));
  await db
    .update(studies)
    .set({ settingsJson: { ...study!.settingsJson, ...settings } })
    .where(eq(studies.id, studyId));
}

export function sineWav(durationMs = 300): Buffer {
  return generateSineWav({ durationMs, sampleRateHz: 16000, frequencyHz: 440 });
}

// Sample files made with ffmpeg at test time (the same approach as
// packages/storage/src/testing/audioSamples.ts). Tests that need them are skipped
// when ffmpeg is not installed.
export function ffmpegInstalled(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ffmpegFile(args: string[], fileName: string): Buffer {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dialect-session-test-"));
  try {
    const output = path.join(directory, fileName);
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args, output], { stdio: "pipe" });
    return readFileSync(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// One second of a sine tone as WebM with Opus, like a MediaRecorder fallback recording.
export function webmOpusSample(durationSeconds = 1): Buffer {
  return ffmpegFile(
    ["-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSeconds}:sample_rate=48000`, "-c:a", "libopus", "-b:a", "32k"],
    "sample.webm",
  );
}

// A WebM file with a video track and no audio.
export function webmVideoSample(): Buffer {
  return ffmpegFile(["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5", "-c:v", "libvpx", "-an"], "video.webm");
}

export function acceptAll(state: ParticipantState): Array<{ itemId: string; accepted: boolean }> {
  if (state.step !== "consent") throw new Error(`Expected the consent step, got ${state.step}`);
  return state.consent.items.map((item) => ({ itemId: item.id, accepted: true }));
}

export function expectStep<S extends ParticipantState["step"]>(
  state: ParticipantState,
  step: S,
): Extract<ParticipantState, { step: S }> {
  if (state.step !== step) throw new Error(`Expected the step ${step}, got ${state.step}`);
  return state as Extract<ParticipantState, { step: S }>;
}

// Creates a session and walks it to the first task.
export async function sessionAtTasks(
  ctx: ServiceContext,
  slug: string,
): Promise<{ created: CreatedSession; session: SessionRef; state: TasksState }> {
  const created = await createSession(ctx, { studySlug: slug });
  const session = created.session;
  await recordConsent(ctx, session, { responses: acceptAll(created.state) });
  await confirmMicCheck(ctx, session, {});
  const state = expectStep(await acknowledgeInstructions(ctx, session), "tasks");
  return { created, session, state };
}

// Answers the current turn: start the task if needed, create the utterance,
// upload a recording and submit it.
export async function answerCurrentTurn(
  ctx: ServiceContext,
  session: SessionRef,
  options: { data?: Buffer; attemptCount?: number } = {},
): Promise<{ state: ParticipantState; utteranceId: string; mediaAssetId: string }> {
  let state = expectStep(await getParticipantState(ctx, session), "tasks");
  if (state.task.status === "pending") {
    state = expectStep(await startTask(ctx, session, state.task.presentationId), "tasks");
  }
  const { utteranceId } = await createUtterance(ctx, session, {
    presentationId: state.task.presentationId,
    turnIndex: state.task.turn.turnIndex,
  });
  const upload = await uploadUtteranceAudio(ctx, session, {
    utteranceId,
    data: options.data ?? sineWav(),
    declaredMimeType: "audio/wav",
    captureMetadata: { captureMethod: "audio_worklet_pcm" },
  });
  const next = await submitUtterance(ctx, session, {
    utteranceId,
    mediaAssetId: upload.mediaAssetId,
    attemptCount: options.attemptCount ?? 1,
  });
  return { state: next, utteranceId, mediaAssetId: upload.mediaAssetId };
}

// Answers every remaining turn of every remaining task.
export async function answerAllTasks(ctx: ServiceContext, session: SessionRef): Promise<ParticipantState> {
  let state = await getParticipantState(ctx, session);
  for (let guard = 0; state.step === "tasks" && guard < 100; guard += 1) {
    state = (await answerCurrentTurn(ctx, session)).state;
  }
  return state;
}
