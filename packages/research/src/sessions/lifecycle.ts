// Session lifecycle: public study information, session creation and lookup,
// consent, microphone check, instructions, completion, withdrawal and
// abandonment (spec 6, 13, 14, 61, 86, 87, 107, 108).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, ne, notInArray, or } from "drizzle-orm";
import {
  consentVersions,
  isUniqueViolation,
  protocolTasks,
  protocolVersions,
  sessionConsents,
  sessions,
  studies,
  taskPresentations,
  type AudioEnvironment,
  type BrowserInfo,
  type ConsentResponse,
  type DbOrTx,
} from "@dialect/db";
import {
  AppError,
  localizeKeyed,
  localizeText,
  TERMINAL_SESSION_STATUSES,
  sessionSchemas,
  type StudyMode,
} from "@dialect/domain";
import type { ServiceContext } from "../context";
import { participantTitleOf } from "../protocols/participant-title";
import { currentProtocolHasExampleText } from "../protocols/validation";
import {
  assertStatus,
  deleteStoredObjects,
  isTerminalStatus,
  loadProtocol,
  lockActiveSession,
  lockSession,
  removeCandidateRows,
  statusAfterTasks,
  type SessionRef,
  type SessionRow,
} from "./internal";
import { buildTaskSequence } from "./ordering";
import {
  effectiveSettings,
  MAINTENANCE_MESSAGE,
  resolveStudy,
  STUDY_CLOSED_MESSAGE,
  type EffectiveSettings,
  type StudyRow,
} from "./settings";
import { deriveStep, getParticipantState } from "./state";

type ParticipantState = sessionSchemas.ParticipantState;

// ---------------------------------------------------------------------------
// Public study information
// ---------------------------------------------------------------------------

async function currentPublishedProtocol(db: DbOrTx, study: StudyRow) {
  if (!study.currentProtocolVersionId) return null;
  const [protocol] = await db
    .select()
    .from(protocolVersions)
    .where(eq(protocolVersions.id, study.currentProtocolVersionId));
  return protocol && protocol.status === "published" ? protocol : null;
}

function closedReason(
  study: StudyRow,
  settings: EffectiveSettings,
  hasProtocol: boolean,
): sessionSchemas.StudyClosedReason | null {
  if (settings.maintenanceMode) return "maintenance";
  if (study.status === "closed") return "study_closed";
  if (study.status === "paused") return "study_paused";
  if (!settings.allowNewSessions) return "new_sessions_disabled";
  if (!hasProtocol) return "no_protocol";
  return null;
}

// What the welcome page needs. No session is required.
export async function getPublicStudyInfo(
  ctx: ServiceContext,
  input: { studySlug?: string } = {},
): Promise<sessionSchemas.StudyInfoResponse> {
  const study = await resolveStudy(ctx.db, input.studySlug);
  const settings = effectiveSettings(study.settingsJson);
  const protocol = await currentPublishedProtocol(ctx.db, study);
  // The same rule as in createSession for a research session: a protocol with
  // example text does not accept participants.
  const reason =
    closedReason(study, settings, protocol !== null) ??
    (protocol !== null && (await currentProtocolHasExampleText(ctx, study.id)) ? "example_text_present" : null);
  return {
    // The participant-facing title, never the internal study name (spec 6.4).
    studyName: participantTitleOf(study),
    acceptingNewSessions: reason === null,
    closedReason: reason,
    closedMessage:
      reason === null
        ? null
        : reason === "maintenance"
          ? (settings.maintenanceMessage ?? MAINTENANCE_MESSAGE)
          : STUDY_CLOSED_MESSAGE,
    welcomeContent: protocol?.welcomeContent ?? null,
    studyNameByLocale: Object.fromEntries(
      settings.participantLocales.map((locale) => [locale, participantTitleOf(study, locale)]),
    ),
    welcomeContentByLocale: Object.fromEntries(
      settings.participantLocales.map((locale) => [
        locale,
        protocol ? localizeText(protocol.welcomeContent, protocol.translationsJson, locale, "welcomeContent") : null,
      ]),
    ),
    locales: settings.participantLocales,
    defaultLocale: settings.defaultLocale,
    studyLaptopMode: settings.studyLaptopMode,
  };
}

// ---------------------------------------------------------------------------
// Session creation and lookup
// ---------------------------------------------------------------------------

// No 0, 1, I, L, O or U: the code is read aloud and typed by people.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;

// A random pseudonymous code such as P-7K4M9Q (spec 14). 30^6 is about 729 million
// values. The code is not sequential and says nothing about the number of participants.
export function generateParticipantCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH * 2)) {
      // 240 is the largest multiple of 30 below 256: every character is equally likely.
      if (byte < 240 && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return `P-${code}`;
}

// 32 random bytes, base64url (43 characters). Same format as the cookie helper of the web app.
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

// Hex SHA-256 of the token. Only this value is stored (sessions.token_hash).
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type CreateSessionInput = {
  // Default "research".
  mode?: StudyMode;
  locale?: string | null;
  browserInfo?: BrowserInfo | null;
  // True only when the route verified an admin session. Required for mode "test".
  // Mode "demo" needs it too, unless the study setting demoPublic is true.
  callerIsAdmin?: boolean;
  studySlug?: string;
};

export type CreatedSession = {
  session: SessionRow;
  // The opaque token for the HttpOnly cookie. It is returned once and never stored.
  token: string;
  tokenExpiresAt: Date;
  state: ParticipantState;
};

const MAX_CODE_ATTEMPTS = 8;

export async function createSession(ctx: ServiceContext, input: CreateSessionInput = {}): Promise<CreatedSession> {
  const mode = input.mode ?? "research";
  const callerIsAdmin = input.callerIsAdmin === true;
  const study = await resolveStudy(ctx.db, input.studySlug);
  const settings = effectiveSettings(study.settingsJson);

  if (mode === "test" && !callerIsAdmin) {
    throw new AppError("FORBIDDEN", "Test sessions can only be started by a signed-in researcher.");
  }
  if (mode === "demo" && !callerIsAdmin && !settings.demoPublic) {
    throw new AppError("FORBIDDEN", "Demo sessions are not open to the public.");
  }

  const protocol = await currentPublishedProtocol(ctx.db, study);
  const reason = closedReason(study, settings, protocol !== null);
  // A researcher can run a test or demo session while the study is paused or
  // closed to new participants. Maintenance mode and a missing protocol stop everyone.
  const adminBypass = callerIsAdmin && mode !== "research" && reason !== "maintenance" && reason !== "no_protocol";
  if (reason !== null && !adminBypass) {
    throw new AppError(
      "STUDY_CLOSED",
      reason === "maintenance" ? (settings.maintenanceMessage ?? MAINTENANCE_MESSAGE) : STUDY_CLOSED_MESSAGE,
      { reason },
    );
  }
  if (!protocol) throw new AppError("STUDY_CLOSED", STUDY_CLOSED_MESSAGE, { reason: "no_protocol" });
  // A protocol that still contains example text (placeholders of the development
  // seed) must not collect research data. TEST and DEMO sessions stay allowed.
  if (mode === "research" && (await currentProtocolHasExampleText(ctx, study.id))) {
    throw new AppError("STUDY_CLOSED", STUDY_CLOSED_MESSAGE, { reason: "example_text_present" });
  }

  const now = ctx.now();
  const token = generateSessionToken();
  const tokenExpiresAt = new Date(now.getTime() + settings.sessionTokenTtlHours * 3600 * 1000);
  const locale =
    input.locale && settings.participantLocales.includes(input.locale) ? input.locale : settings.defaultLocale;

  for (let attempt = 1; ; attempt += 1) {
    const id = randomUUID();
    try {
      // The client address is deliberately not stored (spec 6.2).
      const [session] = await ctx.db
        .insert(sessions)
        .values({
          id,
          studyId: study.id,
          participantCode: generateParticipantCode(),
          // The protocol is pinned here and never changes for this session (spec 76).
          protocolVersionId: protocol.id,
          mode,
          status: "created",
          tokenHash: hashSessionToken(token),
          tokenExpiresAt,
          locale,
          // Derived from the session id, so the task order can be reproduced (spec 8).
          orderSeed: createHash("sha256").update(`order-seed:${id}`, "utf8").digest("hex").slice(0, 32),
          startedAt: now,
          lastActivityAt: now,
          browserInfoJson: input.browserInfo ?? null,
          appVersion: ctx.appVersion,
          gitCommitSha: ctx.gitCommitSha,
        })
        .returning();
      if (!session) throw new AppError("DATABASE_ERROR", "The session could not be created.");
      return { session, token, tokenExpiresAt, state: await getParticipantState(ctx, session) };
    } catch (error) {
      // Two sessions drew the same participant code: draw again.
      if (isUniqueViolation(error) && attempt < MAX_CODE_ATTEMPTS) continue;
      throw error;
    }
  }
}

const SESSION_ENDED_MESSAGE = "Your session has ended. Please start again.";

// Finds the session of a cookie token and records the activity time. Throws
// SESSION_EXPIRED for an unknown token, an expired token and an abandoned session.
// Completed and withdrawn sessions are returned: they are read-only.
export async function getSessionByToken(ctx: ServiceContext, token: string | null | undefined): Promise<SessionRow> {
  if (!token) throw new AppError("SESSION_EXPIRED", SESSION_ENDED_MESSAGE);
  const [session] = await ctx.db.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
  const now = ctx.now();
  if (
    !session ||
    !session.tokenExpiresAt ||
    session.tokenExpiresAt.getTime() <= now.getTime() ||
    session.status === "abandoned"
  ) {
    throw new AppError("SESSION_EXPIRED", SESSION_ENDED_MESSAGE);
  }
  if (isTerminalStatus(session.status)) return session;
  const [touched] = await ctx.db
    .update(sessions)
    .set({ lastActivityAt: now })
    .where(eq(sessions.id, session.id))
    .returning();
  return touched ?? session;
}

// The limits that apply to a session's uploads. The upload route uses them to
// refuse an oversized request before reading it.
export async function getSessionLimits(
  ctx: ServiceContext,
  session: Pick<SessionRow, "studyId">,
): Promise<{ maxUploadMb: number; maxUploadBytes: number; maxUtteranceSeconds: number }> {
  const [study] = await ctx.db.select().from(studies).where(eq(studies.id, session.studyId));
  if (!study) throw new AppError("CONFIGURATION_MISSING", "The study of this session no longer exists.");
  const settings = effectiveSettings(study.settingsJson);
  return {
    maxUploadMb: settings.maxUploadMb,
    maxUploadBytes: settings.maxUploadMb * 1024 * 1024,
    maxUtteranceSeconds: settings.maxUtteranceSeconds,
  };
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

// Stores the consent choices and moves the session on. Nothing is stored when a
// required item is refused: the session stays at the consent step and the
// participant can accept or end participation (spec 6.2, 61).
export async function recordConsent(
  ctx: ServiceContext,
  session: SessionRef,
  input: { responses: Array<{ itemId: string; accepted: boolean }> },
): Promise<ParticipantState> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    const [existing] = await tx.select().from(sessionConsents).where(eq(sessionConsents.sessionId, locked.id));
    // A repeated request (double click, second tab) changes nothing.
    if (existing) return;
    assertStatus(locked, "created", "Giving consent");

    const protocol = await loadProtocol(tx, locked.protocolVersionId);
    const [consent] = protocol.consentVersionId
      ? await tx.select().from(consentVersions).where(eq(consentVersions.id, protocol.consentVersionId))
      : [];
    if (!consent) throw new AppError("CONFIGURATION_MISSING", "The protocol has no consent version.");

    const items = consent.itemsJson;
    const answers = new Map<string, boolean>();
    for (const response of input.responses) {
      if (!items.some((item) => item.id === response.itemId)) {
        throw new AppError("VALIDATION_ERROR", "The consent form contains an unknown item.", {
          reason: "unknown_consent_item",
          itemId: response.itemId,
        });
      }
      if (answers.has(response.itemId)) {
        throw new AppError("VALIDATION_ERROR", "A consent item was answered twice.", {
          reason: "duplicate_consent_item",
          itemId: response.itemId,
        });
      }
      answers.set(response.itemId, response.accepted);
    }
    const unanswered = items.filter((item) => !answers.has(item.id)).map((item) => item.id);
    if (unanswered.length > 0) {
      throw new AppError("VALIDATION_ERROR", "Every consent item must be answered.", {
        reason: "consent_items_unanswered",
        itemIds: unanswered,
      });
    }
    const refused = items.filter((item) => item.required && answers.get(item.id) !== true).map((item) => item.id);
    if (refused.length > 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Taking part is only possible when every required consent item is accepted. You can also end your participation.",
        { reason: "required_consent_not_accepted", itemIds: refused },
      );
    }

    const now = ctx.now();
    // The exact text of every item shown, with the choice made (spec 37.7, 77).
    const responsesJson: ConsentResponse[] = items.map((item) => ({
      itemId: item.id,
      // The text in the language the participant saw it in.
      textSnapshot: localizeKeyed(item.text, consent.translationsJson, locked.locale, "items", item.id),
      required: item.required,
      accepted: answers.get(item.id) === true,
    }));
    await tx
      .insert(sessionConsents)
      .values({ sessionId: locked.id, consentVersionId: consent.id, responsesJson, acceptedAt: now });
    await tx
      .update(sessions)
      .set({ status: "consented", consentedAt: now, lastActivityAt: now })
      .where(eq(sessions.id, locked.id));
  });
  return getParticipantState(ctx, session);
}

// ---------------------------------------------------------------------------
// Microphone check and instructions
// ---------------------------------------------------------------------------

// Device identifiers and the raw device label are never stored (spec 6.2, 6.3).
// The request schema already removes them. This is the second layer, for callers
// that do not go through the schema.
function sanitizeAudioEnvironment(value: AudioEnvironment | null | undefined): AudioEnvironment | null {
  if (!value) return null;
  return {
    ...value,
    ...(value.deviceLabel !== undefined ? { deviceLabel: sessionSchemas.toInputDeviceClass(value.deviceLabel) } : {}),
    ...(value.requestedConstraints
      ? { requestedConstraints: sessionSchemas.stripDeviceIdentifiers(value.requestedConstraints) }
      : {}),
    ...(value.actualTrackSettings
      ? { actualTrackSettings: sessionSchemas.stripDeviceIdentifiers(value.actualTrackSettings) }
      : {}),
  };
}

// Records that the participant confirmed the microphone check. Only technical
// settings are stored (spec 6.3). The test recording never leaves the browser:
// this function takes no audio and no endpoint accepts it.
export async function confirmMicCheck(
  ctx: ServiceContext,
  session: SessionRef,
  input: { audioEnvironment?: AudioEnvironment | null; browserInfo?: BrowserInfo | null } = {},
): Promise<ParticipantState> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    if (locked.status === "mic_check") return;
    assertStatus(locked, "consented", "Confirming the microphone check");
    await tx
      .update(sessions)
      .set({
        status: "mic_check",
        audioEnvironmentJson: sanitizeAudioEnvironment(input.audioEnvironment),
        ...(input.browserInfo ? { browserInfoJson: input.browserInfo } : {}),
        lastActivityAt: ctx.now(),
      })
      .where(eq(sessions.id, locked.id));
  });
  return getParticipantState(ctx, session);
}

// Creates the whole task sequence of the session and opens the task step.
// One task_presentations row per enabled task of the pinned protocol, with text
// snapshots and the randomization metadata (spec 8, 37.8, 77).
export async function acknowledgeInstructions(ctx: ServiceContext, session: SessionRef): Promise<ParticipantState> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    if (locked.status === "recording") return;
    assertStatus(locked, "mic_check", "Starting the tasks");

    const protocol = await loadProtocol(tx, locked.protocolVersionId);
    const tasks = await tx
      .select()
      .from(protocolTasks)
      .where(and(eq(protocolTasks.protocolVersionId, protocol.id), eq(protocolTasks.enabled, true)))
      .orderBy(asc(protocolTasks.orderIndex));
    const sequence = buildTaskSequence(
      tasks.map((task) => ({ ...task, randomizationEligible: task.configJson?.randomizationEligible })),
      protocol.orderConfigJson,
      locked.orderSeed ?? locked.id,
    );
    if (sequence.length > 0) {
      await tx.insert(taskPresentations).values(
        sequence.map(({ task, sequenceIndex, metadata }) => ({
          sessionId: locked.id,
          protocolTaskId: task.id,
          sequenceIndex,
          // The texts in the locale of the session: exactly what the participant sees.
          titleSnapshot: localizeText(task.title, task.translationsJson, locked.locale, "title"),
          promptSnapshot: localizeText(task.participantPrompt, task.translationsJson, locked.locale, "participantPrompt"),
          contextSnapshot: localizeText(task.contextText, task.translationsJson, locked.locale, "contextText"),
          instructionsSnapshot: localizeText(
            task.instructionsText,
            task.translationsJson,
            locked.locale,
            "instructionsText",
          ),
          snapshotLocale: locked.locale,
          randomizationMetadataJson: metadata,
        })),
      );
    }
    await tx
      .update(sessions)
      .set({
        // A protocol without enabled tasks goes straight to what follows the tasks.
        status: sequence.length > 0 ? "recording" : statusAfterTasks(protocol),
        lastActivityAt: ctx.now(),
      })
      .where(eq(sessions.id, locked.id));
  });
  return getParticipantState(ctx, session);
}

// ---------------------------------------------------------------------------
// Completion, withdrawal, abandonment
// ---------------------------------------------------------------------------

// Marks the session completed. Only possible from the debrief step.
// The participant switched the language during the study. The study texts shown
// from then on follow it: consent, instructions, questionnaires, follow-ups, the
// debrief, and the task texts (shownTaskText in ./internal). Texts already shown
// keep their stored copies. A locale the study does not offer is refused.
export async function setSessionLocale(
  ctx: ServiceContext,
  session: SessionRef,
  input: { locale: string },
): Promise<ParticipantState> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked, settings } = await lockActiveSession(tx, session.id);
    if (!settings.participantLocales.includes(input.locale)) {
      throw new AppError("VALIDATION_ERROR", "This language is not offered in this study.", {
        reason: "unknown_locale",
        locale: input.locale,
      });
    }
    if (locked.locale === input.locale) return;
    await tx
      .update(sessions)
      .set({ locale: input.locale, lastActivityAt: ctx.now() })
      .where(eq(sessions.id, locked.id));
  });
  return getParticipantState(ctx, session);
}

export async function completeSession(ctx: ServiceContext, session: SessionRef): Promise<ParticipantState> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked, settings } = await lockSession(tx, session.id);
    if (locked.status === "completed") return;
    if (isTerminalStatus(locked.status)) {
      throw new AppError("INVALID_STATE", "This session has ended and can no longer be changed.", {
        status: locked.status,
      });
    }
    if (settings.maintenanceMode) {
      throw new AppError("STUDY_CLOSED", settings.maintenanceMessage ?? MAINTENANCE_MESSAGE, {
        reason: "maintenance",
      });
    }
    const protocol = await loadProtocol(tx, locked.protocolVersionId);
    const step = await deriveStep(tx, locked, protocol);
    if (step !== "debrief") {
      throw new AppError("INVALID_STATE", "The study can only be finished from the final page.", {
        status: locked.status,
        step,
      });
    }
    const now = ctx.now();
    await tx
      .update(sessions)
      .set({ status: "completed", completedAt: now, lastActivityAt: now })
      .where(eq(sessions.id, locked.id));
  });
  return getParticipantState(ctx, session);
}

// What is removed from a session row that ends before consent was recorded: the
// technical data about the browser and the device, and the locale. The person
// was told that nothing was stored, so nothing about their browser stays. The
// row itself stays (a database guard forbids deleting a research session) with
// its participant code, protocol version, status and timestamps, so the counts
// of started and abandoned sessions remain correct. The token stops working.
const PRE_CONSENT_CLEARED = {
  browserInfoJson: null,
  audioEnvironmentJson: null,
  locale: null,
  tokenHash: null,
  tokenExpiresAt: null,
} as const;

// Ends participation at the participant's request (spec 86).
// From consent onwards the session becomes "withdrawn". Before consent nothing
// was collected: the session becomes "abandoned" and the technical data of its
// row are removed (see PRE_CONSENT_CLEARED).
// An uploaded recording that was not submitted is removed. Submitted data stay:
// what happens to them is decided by the approved protocol and handled by the
// researchers, not by this code. The returned state carries the debrief text.
export async function withdrawSession(ctx: ServiceContext, session: SessionRef): Promise<ParticipantState> {
  const removedKeys = await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockSession(tx, session.id);
    if (locked.status === "withdrawn" || locked.status === "abandoned") return [];
    if (locked.status === "completed") {
      throw new AppError("INVALID_STATE", "This session is already completed.", { status: locked.status });
    }
    const now = ctx.now();
    const keys = await removeCandidateRows(tx, { sessionId: locked.id });
    await tx
      .update(sessions)
      .set(
        locked.status === "created"
          ? { status: "abandoned", abandonedAt: now, lastActivityAt: now, ...PRE_CONSENT_CLEARED }
          : { status: "withdrawn", withdrawnAt: now, lastActivityAt: now },
      )
      .where(eq(sessions.id, locked.id));
    return keys;
  });
  await deleteStoredObjects(ctx, removedKeys);
  return getParticipantState(ctx, session);
}

// Marks sessions without activity for longer than the study's inactivity timeout
// as abandoned and removes their recordings that were never submitted (spec 108).
// Submitted data stay. Called by the worker on a timer. Returns the number of
// sessions marked.
//
// A session that never recorded consent (status "created") has its own, shorter
// timeout (study setting preConsentTimeoutMinutes, default 30): such a session
// holds no study data, and sessions created by a script should not stay open for
// hours. Its technical data are removed like after a declined consent. Demo
// sessions never go through the consent step and keep the normal timeout.
export async function markAbandonedSessions(ctx: ServiceContext): Promise<number> {
  const now = ctx.now();
  let marked = 0;
  const allStudies = await ctx.db.select().from(studies);
  for (const study of allStudies) {
    const settings = effectiveSettings(study.settingsJson);
    const cutoff = new Date(now.getTime() - settings.sessionInactivityTimeoutMinutes * 60 * 1000);
    const preConsentCutoff = new Date(
      now.getTime() -
        Math.min(settings.preConsentTimeoutMinutes, settings.sessionInactivityTimeoutMinutes) * 60 * 1000,
    );
    const isPreConsent = (session: Pick<SessionRow, "status" | "mode" | "consentedAt">) =>
      session.status === "created" && session.mode !== "demo" && session.consentedAt === null;
    const stale = await ctx.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.studyId, study.id),
          notInArray(sessions.status, [...TERMINAL_SESSION_STATUSES]),
          or(
            lt(sessions.lastActivityAt, cutoff),
            and(
              eq(sessions.status, "created"),
              ne(sessions.mode, "demo"),
              isNull(sessions.consentedAt),
              lt(sessions.lastActivityAt, preConsentCutoff),
            ),
          ),
        ),
      );
    for (const { id } of stale) {
      const removedKeys = await ctx.db.transaction(async (tx) => {
        const { session: locked } = await lockSession(tx, id);
        // The participant may have come back between the query and the lock.
        const preConsent = isPreConsent(locked);
        const limit = preConsent ? preConsentCutoff : cutoff;
        if (isTerminalStatus(locked.status) || locked.lastActivityAt.getTime() >= limit.getTime()) return null;
        const keys = await removeCandidateRows(tx, { sessionId: locked.id });
        await tx
          .update(sessions)
          .set({ status: "abandoned", abandonedAt: now, ...(preConsent ? PRE_CONSENT_CLEARED : {}) })
          .where(eq(sessions.id, locked.id));
        return keys;
      });
      if (removedKeys === null) continue;
      marked += 1;
      await deleteStoredObjects(ctx, removedKeys);
    }
  }
  return marked;
}
