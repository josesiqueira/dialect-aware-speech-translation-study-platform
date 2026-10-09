// Builds the ParticipantState: the step the browser must render and the content
// of that step only (spec 107). The server decides the step from the stored
// session, never from anything the browser sends.
//
// This file must never read transcripts, translations, syntheses, model runs or
// model configurations. Research Mode shows no AI output to the participant
// during speech collection (spec 3.1, 83, 110.9). The one exception, the step
// "output_review" after all speaking tasks, is built by output-review.ts, the
// only participant module that reads AI output (docs/IMPLEMENTATION-STATUS.md,
// "Deviations").
import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  consentVersions,
  mediaAssets,
  questionnaireItems,
  questionnaireVersions,
  sessions,
  studies,
  taskPresentations,
  type DbOrTx,
} from "@dialect/db";
import {
  AppError,
  localizeKeyed,
  localizeList,
  localizeText,
  type QuestionnaireKey,
  type sessionSchemas,
} from "@dialect/domain";
import type { ServiceContext } from "../context";
import {
  currentPresentation,
  currentTurnIndex,
  hasQuestionnaireResponse,
  loadProtocol,
  loadTurns,
  loadUtterances,
  shownTaskText,
  UPLOAD_KINDS,
  type ProtocolRow,
  type SessionRef,
  type SessionRow,
} from "./internal";
import { participantTitleOf } from "../protocols/participant-title";
import { effectiveSettings, type EffectiveSettings } from "./settings";
import { englishCheckContent, outputReviewContent, reviewStepOf } from "./output-review";

type ParticipantState = sessionSchemas.ParticipantState;
type ParticipantStep = sessionSchemas.ParticipantStep;

// Mapping from sessions.status to the step. Documented in docs/PARTICIPANT-API.md.
export async function deriveStep(
  db: DbOrTx,
  session: SessionRow,
  protocol: ProtocolRow,
  settings?: EffectiveSettings,
): Promise<ParticipantStep> {
  switch (session.status) {
    case "created":
      return "consent";
    case "consented":
      return "mic_check";
    case "mic_check":
      return "instructions";
    case "recording":
      return "tasks";
    case "background_questionnaire":
      return "background";
    case "post_questionnaire": {
      const postId = protocol.postQuestionnaireVersionId;
      if (postId && !(await hasQuestionnaireResponse(db, session.id, postId))) return "post_recording";
      // Then the output review part, when it applies (output-review.ts).
      const reviewStep = await reviewStepOf(db, session, protocol, settings ?? (await loadSettings(db, session.studyId)));
      return reviewStep ?? "debrief";
    }
    case "completed":
      return "completed";
    case "withdrawn":
    case "abandoned":
      return "withdrawn";
  }
}

async function loadSettings(db: DbOrTx, studyId: string): Promise<EffectiveSettings> {
  const [study] = await db.select({ settingsJson: studies.settingsJson }).from(studies).where(eq(studies.id, studyId));
  if (!study) throw new AppError("CONFIGURATION_MISSING", "The study of this session no longer exists.");
  return effectiveSettings(study.settingsJson);
}

// Study texts are shown in the locale of the session; a text without a
// translation falls back to the base text (packages/domain/src/localization.ts).
export async function loadConsent(
  db: DbOrTx,
  protocol: ProtocolRow,
  locale: string | null,
): Promise<sessionSchemas.ConsentContent> {
  const [consent] = protocol.consentVersionId
    ? await db.select().from(consentVersions).where(eq(consentVersions.id, protocol.consentVersionId))
    : [];
  if (!consent) throw new AppError("CONFIGURATION_MISSING", "The protocol has no consent version.");
  return {
    consentVersionId: consent.id,
    versionNumber: consent.versionNumber,
    title: localizeText(consent.title, consent.translationsJson, locale, "title"),
    informationText: localizeText(consent.informationText, consent.translationsJson, locale, "informationText"),
    items: consent.itemsJson.map((item) => ({
      id: item.id,
      text: localizeKeyed(item.text, consent.translationsJson, locale, "items", item.id),
      required: item.required,
    })),
    privacyNoticeUrl: consent.privacyNoticeUrl,
    contactText: localizeText(consent.contactText, consent.translationsJson, locale, "contactText"),
  };
}

async function loadDebrief(
  db: DbOrTx,
  protocol: ProtocolRow,
  locale: string | null,
): Promise<sessionSchemas.DebriefContent> {
  const [consent] = protocol.consentVersionId
    ? await db
        .select({ contactText: consentVersions.contactText, translationsJson: consentVersions.translationsJson })
        .from(consentVersions)
        .where(eq(consentVersions.id, protocol.consentVersionId))
    : [];
  return {
    content: localizeText(protocol.debriefContent, protocol.translationsJson, locale, "debriefContent"),
    contactText: consent ? localizeText(consent.contactText, consent.translationsJson, locale, "contactText") : null,
  };
}

type QuestionnaireItemRow = typeof questionnaireItems.$inferSelect;

// One questionnaire item as the participant sees it: prompt, help text, option
// labels and scale labels in the locale of the session. Option values never
// change, so answers mean the same in every language.
export function localizeQuestionnaireItem(
  item: QuestionnaireItemRow,
  locale: string | null,
): sessionSchemas.QuestionnaireContent["items"][number] {
  const t = item.translationsJson;
  const config = item.configJson ?? {};
  const localized = { ...config };
  if (config.options) {
    localized.options = config.options.map((option) => ({
      ...option,
      label: localizeKeyed(option.label, t, locale, "options", option.value),
    }));
  }
  for (const field of ["scaleMinLabel", "scaleMaxLabel", "placeholder"] as const) {
    const value = config[field];
    if (typeof value === "string") localized[field] = localizeText(value, t, locale, field);
  }
  return {
    itemKey: item.itemKey,
    type: item.type,
    prompt: localizeText(item.prompt, t, locale, "prompt"),
    helpText: localizeText(item.helpText, t, locale, "helpText"),
    required: item.required,
    config: localized,
  };
}

async function loadQuestionnaire(
  db: DbOrTx,
  key: QuestionnaireKey,
  versionId: string | null,
  locale: string | null,
): Promise<sessionSchemas.QuestionnaireContent> {
  const [version] = versionId
    ? await db.select().from(questionnaireVersions).where(eq(questionnaireVersions.id, versionId))
    : [];
  if (!version) throw new AppError("CONFIGURATION_MISSING", "The protocol has no such questionnaire.");
  const items = await db
    .select()
    .from(questionnaireItems)
    .where(eq(questionnaireItems.questionnaireVersionId, version.id))
    .orderBy(asc(questionnaireItems.orderIndex), asc(questionnaireItems.itemKey));
  return {
    key,
    questionnaireVersionId: version.id,
    versionNumber: version.versionNumber,
    name: localizeText(version.name, version.translationsJson, locale, "name"),
    description: localizeText(version.description, version.translationsJson, locale, "description"),
    items: items.map((item) => localizeQuestionnaireItem(item, locale)),
  };
}

async function loadCurrentTask(
  db: DbOrTx,
  session: SessionRow,
  settings: EffectiveSettings,
): Promise<{ task: sessionSchemas.CurrentTask; progress: sessionSchemas.ParticipantProgress }> {
  const presentation = await currentPresentation(db, session.id);
  if (!presentation) {
    throw new AppError("INVALID_STATE", "The session has no task left to present.");
  }
  const [total] = await db
    .select({ value: count() })
    .from(taskPresentations)
    .where(eq(taskPresentations.sessionId, session.id));
  const { task, turns } = await loadTurns(db, presentation, session.locale);
  const rows = await loadUtterances(db, presentation.id);
  const turnIndex = currentTurnIndex(turns, rows) ?? 0;
  const turn = turns[turnIndex] ?? turns[0];
  if (!turn) throw new AppError("INVALID_STATE", "The task has no prompt.");
  const utterance = rows.find((row) => row.turnIndex === turn.turnIndex && row.status !== "submitted") ?? null;

  let candidate: sessionSchemas.CurrentTurn["candidate"] = null;
  if (utterance) {
    const [media] = await db
      .select({ id: mediaAssets.id, durationMs: mediaAssets.durationMs })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.utteranceId, utterance.id), inArray(mediaAssets.kind, [...UPLOAD_KINDS])))
      .limit(1);
    if (media) candidate = { mediaAssetId: media.id, durationMs: media.durationMs };
  }

  return {
    progress: { taskNumber: presentation.sequenceIndex + 1, totalTasks: total?.value ?? 0 },
    task: {
      presentationId: presentation.id,
      status: presentation.status === "started" ? "started" : "pending",
      // The stored snapshots, not the protocol rows (spec 8, 77), unless the
      // participant switched the language after they were taken (shownTaskText).
      title: shownTaskText(presentation.titleSnapshot, presentation, task, session.locale, "title"),
      prompt: shownTaskText(presentation.promptSnapshot, presentation, task, session.locale, "participantPrompt"),
      context: shownTaskText(presentation.contextSnapshot, presentation, task, session.locale, "contextText"),
      instructions: shownTaskText(
        presentation.instructionsSnapshot,
        presentation,
        task,
        session.locale,
        "instructionsText",
      ),
      taskType: task.taskType,
      minDurationSeconds: task.minDurationSeconds,
      suggestedDurationSeconds: task.suggestedDurationSeconds,
      maxDurationSeconds: taskMaxDurationSeconds(task.maxDurationSeconds, settings),
      privacyReminder: task.privacyReminder,
      topicSuggestions: localizeList(
        task.configJson?.topicSuggestions ?? [],
        task.translationsJson,
        session.locale,
        "topicSuggestions",
      ),
      turn: {
        turnIndex: turn.turnIndex,
        totalTurns: turns.length,
        promptText: turn.promptText,
        isFollowup: turn.isFollowup,
        isOptional: turn.isOptional,
        utteranceId: utterance?.id ?? null,
        candidate,
      },
    },
  };
}

// The task's own limit, never above the study limit.
export function taskMaxDurationSeconds(taskMax: number | null, settings: EffectiveSettings): number {
  return taskMax ? Math.min(taskMax, settings.maxUtteranceSeconds) : settings.maxUtteranceSeconds;
}

export async function buildParticipantState(
  db: DbOrTx,
  sessionId: string,
  now: Date = new Date(),
): Promise<ParticipantState> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) throw new AppError("SESSION_EXPIRED", "Your session was not found. Please start again.");
  const [study] = await db.select().from(studies).where(eq(studies.id, session.studyId));
  if (!study) throw new AppError("CONFIGURATION_MISSING", "The study of this session no longer exists.");
  const protocol = await loadProtocol(db, session.protocolVersionId);
  const settings = effectiveSettings(study.settingsJson);
  const step = await deriveStep(db, session, protocol, settings);

  const base: sessionSchemas.ParticipantStateBase = {
    participantCode: session.participantCode,
    mode: session.mode,
    locale: session.locale,
    // The participant-facing title, never the internal study name (spec 6.4).
    studyName: participantTitleOf(study, session.locale),
    progress: null,
    settings: {
      maxUtteranceSeconds: settings.maxUtteranceSeconds,
      maxUploadMb: settings.maxUploadMb,
      studyLaptopMode: settings.studyLaptopMode,
    },
  };

  switch (step) {
    case "consent":
      return {
        ...base,
        step,
        information: {
          content: localizeText(protocol.informationContent, protocol.translationsJson, session.locale, "informationContent"),
        },
        consent: await loadConsent(db, protocol, session.locale),
      };
    case "mic_check":
      return { ...base, step };
    case "instructions":
      return {
        ...base,
        step,
        instructions: {
          content: localizeText(protocol.instructionContent, protocol.translationsJson, session.locale, "instructionContent"),
        },
      };
    case "tasks": {
      const { task, progress } = await loadCurrentTask(db, session, settings);
      return { ...base, progress, step, task };
    }
    case "background":
      return {
        ...base,
        step,
        questionnaire: await loadQuestionnaire(
          db,
          "background",
          protocol.backgroundQuestionnaireVersionId,
          session.locale,
        ),
      };
    case "post_recording":
      return {
        ...base,
        step,
        questionnaire: await loadQuestionnaire(
          db,
          "post_recording",
          protocol.postQuestionnaireVersionId,
          session.locale,
        ),
      };
    case "english_check":
      return { ...base, step, englishCheck: englishCheckContent() };
    case "output_review":
      return { ...base, step, review: await outputReviewContent(db, session, now) };
    case "post_review":
      return {
        ...base,
        step,
        questionnaire: await loadQuestionnaire(
          db,
          "post_review",
          protocol.postReviewQuestionnaireVersionId,
          session.locale,
        ),
      };
    case "debrief":
      return { ...base, step, debrief: await loadDebrief(db, protocol, session.locale) };
    case "completed":
      return { ...base, step };
    case "withdrawn":
      return { ...base, step, debrief: await loadDebrief(db, protocol, session.locale) };
  }
}

// The state of a session, read fresh from the database. Asking again without a
// change in between gives the same answer (refresh resilience, spec 61).
export async function getParticipantState(ctx: ServiceContext, session: SessionRef): Promise<ParticipantState> {
  return buildParticipantState(ctx.db, session.id, ctx.now());
}

// The step of a session inside a transaction, for the services that must check it.
export async function currentStepOf(db: DbOrTx, sessionId: string): Promise<ParticipantStep> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) throw new AppError("SESSION_EXPIRED", "Your session was not found. Please start again.");
  const protocol = await loadProtocol(db, session.protocolVersionId);
  return deriveStep(db, session, protocol);
}
