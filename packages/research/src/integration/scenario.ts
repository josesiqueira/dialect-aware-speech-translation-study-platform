// Shared scenario helpers for the cross-slice integration tests (spec 90.2) and
// the scientific invariant tests (spec 110). Not exported from the package.
//
// Everything here goes through the real services: a study is configured with the
// protocols and questionnaires services, a participant walks the session
// services with real WAV bytes, the queue is drained with the real job handlers
// and the deterministic test adapters. Research data is never processed with
// the provider named "mock", so the configurations use RESEARCH_TEST_PROVIDER
// (the same adapters under another name, see processing/test-helpers.ts).
// Builders are used only for what has no service: the study row and the four
// seeded AI configurations.
import { asc, eq } from "drizzle-orm";
import {
  jobs,
  mediaAssets,
  studies,
  utterances,
  type StudySettings,
} from "@dialect/db";
import { insertActiveAiConfigs, insertStudy, type ActiveAiConfigs, type StudyRow } from "@dialect/db/testing-builders";
import type { StudyMode, TaskType, sessionSchemas } from "@dialect/domain";
import { generateSineWav, sha256OfBuffer } from "@dialect/storage";
import * as aiConfig from "../ai-config";
import type { ServiceContext } from "../context";
import * as exportsArea from "../exports";
import { readZip, streamToBuffer } from "../exports/test-helpers";
import { processOneJob, type JobHandlerRegistry } from "../jobs";
import * as processing from "../processing";
import { RESEARCH_TEST_PROVIDER, useResearchTestProvider } from "../processing/test-helpers";
import * as protocols from "../protocols";
import * as questionnaires from "../questionnaires";
import * as sessions from "../sessions";
import type { TestServiceContext } from "../testing";
import * as transcripts from "../transcripts";

export type ParticipantState = sessionSchemas.ParticipantState;

// The handlers the worker registers (apps/worker/src/handlers.ts).
export const ALL_JOB_HANDLERS: JobHandlerRegistry = { ...processing.jobHandlers, ...exportsArea.jobHandlers };

export const BACKGROUND_ANSWERS = { age_range: "25_34", region_grew_up: "Kuopio" };
export const POST_ANSWERS = { naturalness: 4, comment: "Puhuin niin kuin kotona." };

export type ScenarioStudy = {
  study: StudyRow;
  slug: string;
  consent: protocols.ConsentVersionRow;
  backgroundVersionId: string;
  postVersionId: string;
  protocol: protocols.ProtocolDetail;
  ai: ActiveAiConfigs;
};

export type StudyOptions = {
  settings?: StudySettings;
  // false leaves the AI configuration out (no active model config at all).
  aiConfigs?: boolean;
};

// A study configured the way a researcher does it: a published consent version,
// two published questionnaires, and a protocol that is created, edited and
// published through the services. The protocol has a controlled task, a
// semi-structured task with one required follow-up, and a free speech task, in
// fixed order, so a session has four recording turns.
export async function setupStudy(t: TestServiceContext, options: StudyOptions = {}): Promise<ScenarioStudy> {
  useResearchTestProvider(t);
  const admin = t.adminCtx;
  const study = await insertStudy(t.testDb.db, {
    settingsJson: {
      allowNewSessions: true,
      autoQueueAsr: true,
      sourceLanguage: "fi",
      targetLanguage: "en",
      transcriptionConventionVersion: "conventions-v1",
      annotationSchemeVersion: "difference-scheme-v1",
      ...options.settings,
    },
  });

  const consentDraft = await protocols.createConsentDraft(admin, {
    studyId: study.id,
    title: "Consent to take part",
    informationText: "You will record short spoken answers in your own way of speaking.",
    contactText: "Contact: research team.",
    items: [
      { id: "participation", text: "I agree to take part in the study.", required: true, scope: "participation" },
      { id: "voice_recording", text: "I agree that my voice is recorded.", required: true, scope: "voice_recording" },
      // Automatic transcription is queued only for a session that accepted this scope.
      {
        id: "external_ai_processing",
        text: "I agree that my recordings are processed with external AI services.",
        required: true,
        scope: "external_ai_processing",
      },
      { id: "future_reuse", text: "My recordings may be reused in later studies.", required: false, scope: "future_reuse" },
    ],
  });
  const consent = await protocols.publishConsentVersion(admin, consentDraft.id);

  const background = await questionnaires.createQuestionnaireDraft(admin, {
    studyId: study.id,
    key: "background",
    name: "Background",
  });
  await questionnaires.addItem(admin, background.id, {
    itemKey: "age_range",
    type: "single_choice",
    prompt: "What is your age range?",
    required: true,
    config: {
      options: [
        { value: "18_24", label: "18 to 24" },
        { value: "25_34", label: "25 to 34" },
      ],
    },
  });
  await questionnaires.addItem(admin, background.id, {
    itemKey: "region_grew_up",
    type: "short_text",
    prompt: "Where did you grow up?",
    required: true,
    config: { maxLength: 80 },
  });
  await questionnaires.publishQuestionnaireVersion(admin, background.id);

  const post = await questionnaires.createQuestionnaireDraft(admin, {
    studyId: study.id,
    key: "post_recording",
    name: "After the recordings",
  });
  await questionnaires.addItem(admin, post.id, {
    itemKey: "naturalness",
    type: "likert",
    prompt: "How naturally did you speak?",
    required: true,
    config: { scaleMin: 1, scaleMax: 5, scaleMinLabel: "Not at all", scaleMaxLabel: "Completely" },
  });
  await questionnaires.addItem(admin, post.id, { itemKey: "comment", type: "free_text", prompt: "Any comments?" });
  await questionnaires.publishQuestionnaireVersion(admin, post.id);

  const draft = await protocols.createProtocolDraft(admin, { studyId: study.id, name: "Integration protocol" });
  const protocolId = draft.protocol.id;
  await protocols.updateProtocolDraft(admin, protocolId, {
    welcomeContent: "Welcome to the study.",
    informationContent: "What the study is about.",
    instructionContent: "Speak the way you speak at home.",
    debriefContent: "Thank you for taking part.",
    consentVersionId: consent.id,
    backgroundQuestionnaireVersionId: background.id,
    postQuestionnaireVersionId: post.id,
    orderConfig: {
      blocks: [
        { key: "controlled", orderMode: "fixed" },
        { key: "semi_structured", orderMode: "fixed" },
        { key: "free", orderMode: "fixed" },
      ],
    },
  });
  await protocols.addTask(admin, protocolId, {
    taskKey: "invite_friend",
    taskType: "controlled",
    blockKey: "controlled",
    title: "Invite a friend",
    participantPrompt: "Ask a friend to come for coffee on Saturday.",
    maxDurationSeconds: 120,
  });
  const withSemi = await protocols.addTask(admin, protocolId, {
    taskKey: "last_weekend",
    taskType: "semi_structured",
    blockKey: "semi_structured",
    title: "Last weekend",
    participantPrompt: "Tell what you did last weekend.",
    maxDurationSeconds: 180,
  });
  const semi = withSemi.tasks.find((task) => task.taskKey === "last_weekend");
  if (!semi) throw new Error("The semi-structured task was not created.");
  await protocols.addFollowup(admin, semi.id, {
    followupKey: "best_part",
    promptText: "What was the best part of it?",
    isRequired: true,
  });
  await protocols.addTask(admin, protocolId, {
    taskKey: "free_topic",
    taskType: "free_speech",
    blockKey: "free",
    title: "Free speech",
    participantPrompt: "Talk about anything you like.",
    suggestedDurationSeconds: 60,
    maxDurationSeconds: 300,
    privacyReminder: true,
  });
  // An edit of the draft before publication: the published text is the edited one.
  await protocols.updateTask(admin, semi.id, { participantPrompt: "Tell what you did last weekend, in your own words." });
  const published = await protocols.publishProtocol(admin, protocolId);

  const ai =
    options.aiConfigs === false
      ? ({} as ActiveAiConfigs)
      : await insertActiveAiConfigs(t.testDb.db, { studyId: study.id, provider: RESEARCH_TEST_PROVIDER });

  return {
    study,
    slug: study.slug,
    consent,
    backgroundVersionId: background.id,
    postVersionId: post.id,
    protocol: published.protocol,
    ai,
  };
}

let toneCounter = 0;

// Real WAV bytes. Every call gives a different tone, so every recording has its
// own hash and the mock ASR (which derives its text from the hash) differs too.
export function recording(durationMs = 250): Buffer {
  toneCounter += 1;
  return generateSineWav({ durationMs, sampleRateHz: 16000, frequencyHz: 180 + toneCounter * 7 });
}

export type RecordedTurn = {
  utteranceId: string;
  mediaAssetId: string;
  audio: Buffer;
  sha256: string;
  presentationId: string;
  turnIndex: number;
  taskType: TaskType;
  taskTitle: string;
  // The exact prompt the participant saw for this turn.
  promptText: string;
  isFollowup: boolean;
};

export type SessionRun = {
  session: sessions.SessionRow;
  token: string;
  participantCode: string;
  turns: RecordedTurn[];
  // Every participant state the services returned, in order.
  states: ParticipantState[];
  finalState: ParticipantState;
};

export type SessionOptions = {
  mode?: StudyMode;
  // "tasks" stops after the last recording, "all" also answers the
  // questionnaires and completes the session.
  until?: "consent" | "tasks" | "all";
};

function atStep<S extends ParticipantState["step"]>(state: ParticipantState, step: S): Extract<ParticipantState, { step: S }> {
  if (state.step !== step) throw new Error(`Expected the step ${step}, got ${state.step}`);
  return state as Extract<ParticipantState, { step: S }>;
}

// Records the current turn of a session that is at the step "tasks": starts the
// task when needed, creates the utterance, uploads a recording and submits it.
export async function recordCurrentTurn(
  ctx: ServiceContext,
  session: sessions.SessionRef,
): Promise<{ turn: RecordedTurn; state: ParticipantState }> {
  let tasks = atStep(await sessions.getParticipantState(ctx, session), "tasks");
  if (tasks.task.status === "pending") {
    tasks = atStep(await sessions.startTask(ctx, session, tasks.task.presentationId), "tasks");
  }
  const { task } = tasks;
  const { utteranceId } = await sessions.createUtterance(ctx, session, {
    presentationId: task.presentationId,
    turnIndex: task.turn.turnIndex,
  });
  const audio = recording();
  const upload = await sessions.uploadUtteranceAudio(ctx, session, {
    utteranceId,
    data: audio,
    declaredMimeType: "audio/wav",
    captureMetadata: { captureMethod: "audio_worklet_pcm" },
  });
  const state = await sessions.submitUtterance(ctx, session, {
    utteranceId,
    mediaAssetId: upload.mediaAssetId,
    attemptCount: 1,
  });
  return {
    state,
    turn: {
      utteranceId,
      mediaAssetId: upload.mediaAssetId,
      audio,
      sha256: sha256OfBuffer(audio),
      presentationId: task.presentationId,
      turnIndex: task.turn.turnIndex,
      taskType: task.taskType,
      taskTitle: task.title,
      promptText: task.turn.promptText,
      isFollowup: task.turn.isFollowup,
    },
  };
}

// One participant from the welcome page to the completion screen, through the
// session services only.
export async function runSession(ctx: ServiceContext, slug: string, options: SessionOptions = {}): Promise<SessionRun> {
  const mode = options.mode ?? "research";
  const until = options.until ?? "all";
  const created = await sessions.createSession(ctx, { studySlug: slug, mode, callerIsAdmin: mode !== "research" });
  const session = created.session;
  const states: ParticipantState[] = [created.state];
  const turns: RecordedTurn[] = [];
  const run = (): SessionRun => ({
    session,
    token: created.token,
    participantCode: session.participantCode,
    turns,
    states,
    finalState: states[states.length - 1]!,
  });
  const push = (state: ParticipantState) => {
    states.push(state);
    return state;
  };

  const consentState = atStep(created.state, "consent");
  push(
    await sessions.recordConsent(ctx, session, {
      responses: consentState.consent.items.map((item) => ({ itemId: item.id, accepted: true })),
    }),
  );
  if (until === "consent") return run();
  push(await sessions.confirmMicCheck(ctx, session, {}));
  let state = push(await sessions.acknowledgeInstructions(ctx, session));

  for (let guard = 0; state.step === "tasks" && guard < 50; guard += 1) {
    const recorded = await recordCurrentTurn(ctx, session);
    turns.push(recorded.turn);
    state = push(recorded.state);
  }
  if (until === "tasks") return run();
  for (const next of await finishSession(ctx, session)) push(next);
  return run();
}

// From the end of the recordings to the completion screen: both questionnaires,
// then completion. Returns every state on the way.
export async function finishSession(ctx: ServiceContext, session: sessions.SessionRef): Promise<ParticipantState[]> {
  const states: ParticipantState[] = [];
  atStep(await sessions.getParticipantState(ctx, session), "background");
  states.push(await sessions.submitQuestionnaire(ctx, session, { key: "background", answers: BACKGROUND_ANSWERS }));
  atStep(states[states.length - 1]!, "post_recording");
  states.push(await sessions.submitQuestionnaire(ctx, session, { key: "post_recording", answers: POST_ANSWERS }));
  states.push(await sessions.completeSession(ctx, session));
  return states;
}

export type ConfigSpec = {
  key: string;
  stage: "asr" | "translation" | "tts";
  conditionKey?: string | null;
  modelId?: string;
  parameters?: Record<string, unknown>;
  // Translation and TTS need an instruction. ASR may run without one.
  promptText?: string;
};

// Creates and activates a model configuration (and its prompt version) with the
// deterministic test adapters, through the ai-config services. Used for configurations that
// fail on purpose (parameters mockFail, mockFailTimes).
export async function activateMockConfig(admin: ServiceContext, studyId: string, spec: ConfigSpec) {
  let promptVersionId: string | null = null;
  if (spec.promptText !== undefined) {
    const prompt = await aiConfig.createPromptDraft(admin, {
      studyId,
      key: spec.key,
      stage: spec.stage,
      conditionKey: spec.conditionKey ?? null,
      name: `${spec.key} prompt`,
      promptText: spec.promptText,
    });
    promptVersionId = (await aiConfig.activatePromptVersion(admin, prompt.id)).prompt.id;
  }
  const draft = await aiConfig.createModelConfigDraft(admin, {
    studyId,
    key: spec.key,
    stage: spec.stage,
    conditionKey: spec.conditionKey ?? null,
    provider: RESEARCH_TEST_PROVIDER,
    modelId: spec.modelId ?? `mock-${spec.stage}`,
    parameters: spec.parameters ?? {},
    promptVersionId,
  });
  return (await aiConfig.activateModelConfig(admin, draft.id)).config;
}

// Runs queued jobs with the real handlers until none is available. A job that
// failed with a retryable error waits for its backoff: advance the test clock
// and drain again to run the retry.
export async function drainQueue(
  ctx: ServiceContext,
  options: { handlers?: JobHandlerRegistry; limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 2000;
  let processed = 0;
  for (;;) {
    const result = await processOneJob({
      deps: { ctx },
      handlers: options.handlers ?? ALL_JOB_HANDLERS,
      workerId: "integration-test",
    });
    if (result === "idle") return processed;
    processed += 1;
    if (processed > limit) throw new Error("The queue did not become idle.");
  }
}

export type ReviewedUtterance = {
  b: { transcriptId: string; revisionId: string; text: string };
  c: { transcriptId: string; revisionId: string; text: string };
  aStar: { transcriptId: string; revisionId: string; text: string } | null;
};

// The researcher writes and verifies B (dialect-preserving) and C (normalized),
// and optionally A* (corrected ASR), through the transcripts service.
export async function reviewUtterance(
  admin: ServiceContext,
  utteranceId: string,
  texts: { b: string; c: string; aStar?: string },
): Promise<ReviewedUtterance> {
  const saveAndVerify = async (type: "human_dialect" | "normalized" | "asr_corrected", text: string, derivedFrom?: string) => {
    const saved = await transcripts.saveTranscriptRevision(admin, {
      utteranceId,
      type,
      text,
      ...(derivedFrom ? { derivedFromRevisionId: derivedFrom } : {}),
    });
    await transcripts.verifyTranscript(admin, { transcriptId: saved.transcript.id, revisionId: saved.revision.id });
    return { transcriptId: saved.transcript.id, revisionId: saved.revision.id, text };
  };
  const b = await saveAndVerify("human_dialect", texts.b);
  const c = await saveAndVerify("normalized", texts.c, b.revisionId);
  const aStar = texts.aStar === undefined ? null : await saveAndVerify("asr_corrected", texts.aStar);
  return { b, c, aStar };
}

// Creates an export job through the exports service, lets the export job handler
// build it, downloads the archive through the service and unpacks it.
export async function buildExportArchive(
  admin: ServiceContext,
  input: exportsArea.CreateExportJobInput,
): Promise<{ job: exportsArea.ExportJobDetail; archive: Buffer; files: Map<string, Buffer> }> {
  const created = await exportsArea.createExportJob(admin, input);
  // Only this export job: other queued jobs are left alone.
  for (let guard = 0; guard < 100; guard += 1) {
    const result = await processOneJob({
      deps: { ctx: admin },
      handlers: exportsArea.jobHandlers,
      workerId: "integration-export",
      types: [exportsArea.EXPORT_JOB_TYPE],
    });
    if (result === "idle") break;
  }
  const job = await exportsArea.getExportJob(admin, created.id);
  if (job.status !== "completed") throw new Error(`The export did not complete: ${job.status} ${job.errorMessage ?? ""}`);
  const download = await exportsArea.openExportDownload(admin, job.id);
  const archive = await streamToBuffer(download.stream);
  return { job, archive, files: readZip(archive) };
}

export async function storedBytes(ctx: ServiceContext, storageKey: string): Promise<Buffer> {
  return streamToBuffer(await ctx.storage.get(storageKey));
}

// Every object key and every string value inside a value, at any depth. Used to
// prove that a payload does not contain a text or a field it must not contain.
export function deepKeysAndStrings(value: unknown): { keys: string[]; strings: string[] } {
  const keys: string[] = [];
  const strings: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === "string") strings.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node instanceof Date) strings.push(node.toISOString());
    else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        keys.push(key);
        visit(child);
      }
    }
  };
  visit(value);
  return { keys, strings };
}

export async function jobsOf(ctx: ServiceContext, filter: { type?: string } = {}) {
  const rows = await ctx.db.select().from(jobs).orderBy(asc(jobs.createdAt), asc(jobs.id));
  return filter.type ? rows.filter((job) => job.type === filter.type) : rows;
}

export async function utteranceRow(ctx: ServiceContext, utteranceId: string) {
  const [row] = await ctx.db.select().from(utterances).where(eq(utterances.id, utteranceId));
  if (!row) throw new Error("The utterance does not exist.");
  return row;
}

export async function mediaRow(ctx: ServiceContext, mediaAssetId: string) {
  const [row] = await ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaAssetId));
  if (!row) throw new Error("The media asset does not exist.");
  return row;
}

export async function changeStudySettings(ctx: ServiceContext, studyId: string, settings: StudySettings): Promise<void> {
  const [study] = await ctx.db.select().from(studies).where(eq(studies.id, studyId));
  if (!study) throw new Error("The study does not exist.");
  await ctx.db
    .update(studies)
    .set({ settingsJson: { ...study.settingsJson, ...settings } })
    .where(eq(studies.id, studyId));
}
