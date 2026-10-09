// Demo sessions (spec 3.2, 78, 80). A demo session is a row in `sessions` with
// mode `demo`. It is created through the same session service as every other
// session, so the mode rules live in one place, and it never enters the
// participant task flow: Demo Mode has its own code path.
import { count, eq } from "drizzle-orm";
import { sessions as sessionsTable, studies, utterances, type BrowserInfo } from "@dialect/db";
import { AppError, demoSchemas, isAppError } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { createSession, getSessionByToken } from "../sessions/lifecycle";
import { isTerminalStatus, lockSession, type SessionRow } from "../sessions/internal";
import { effectiveSettings, resolveStudy, type StudyRow } from "../sessions/settings";
import { mockProviderAvailable } from "./mock-configs";

// What Demo Mode keeps in sessions.browser_info_json next to the browser fields.
export type DemoAcknowledgement = {
  acknowledgedAt: string;
  noticeVersion: string;
  // The exact text the visitor agreed to.
  noticeText: string[];
};

export type DemoBrowserInfo = BrowserInfo & { demoAcknowledgement?: DemoAcknowledgement };

export type DemoSettings = {
  demoPublic: boolean;
  demoPersist: boolean;
  // Largest number of demo pipeline runs in 24 hours, over all visitors.
  demoDailyRunLimit: number;
};

// Default of the study setting demoDailyRunLimit (studies.settings_json).
export const DEFAULT_DEMO_DAILY_RUN_LIMIT = 200;

// Accepted range of the setting, the same as on the Settings page.
export const DEMO_DAILY_RUN_LIMIT_RANGE = { min: 1, max: 100_000 } as const;

function dailyRunLimitOf(settings: StudyRow["settingsJson"]): number {
  const value = (settings as { demoDailyRunLimit?: unknown }).demoDailyRunLimit;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= DEMO_DAILY_RUN_LIMIT_RANGE.min &&
    value <= DEMO_DAILY_RUN_LIMIT_RANGE.max
    ? value
    : DEFAULT_DEMO_DAILY_RUN_LIMIT;
}

export function demoSettings(study: Pick<StudyRow, "settingsJson">): DemoSettings {
  return {
    demoDailyRunLimit: dailyRunLimitOf(study.settingsJson),
    demoPublic: effectiveSettings(study.settingsJson).demoPublic,
    // Keeping demo data is the default: a seminar recording should be inspectable
    // afterwards (spec 163). Deleting it is the explicit setting (spec 80).
    demoPersist: study.settingsJson.demoPersist ?? true,
  };
}

// What the demo page needs to know before a session exists.
export async function getDemoAccess(
  ctx: ServiceContext,
  input: { isAdmin: boolean; studySlug?: string },
): Promise<demoSchemas.DemoAccess> {
  const study = await resolveStudy(ctx.db, input.studySlug);
  const { demoPublic, demoPersist } = demoSettings(study);
  const limits = effectiveSettings(study.settingsJson);
  return {
    demoPublic,
    demoPersist,
    // The mock provider is a development tool. A public visitor never gets it.
    mockAvailable: input.isAdmin && mockProviderAvailable(ctx),
    // A demo recording has the limits of a study recording.
    maxRecordingSeconds: limits.maxUtteranceSeconds,
    maxUploadBytes: limits.maxUploadMb * 1024 * 1024,
  };
}

export type StartDemoSessionInput = {
  // The visitor accepted the recording notice on the demo page. Required.
  acknowledged: boolean;
  locale?: string | null;
  browserInfo?: BrowserInfo | null;
  // True only when the route verified an admin session.
  isAdmin: boolean;
  studySlug?: string;
};

export type StartedDemoSession = {
  session: SessionRow;
  // The opaque token for the HttpOnly demo cookie. Returned once, never stored.
  token: string;
  tokenExpiresAt: Date;
  info: demoSchemas.DemoSessionInfo;
};

// Creates a session with mode `demo`. Allowed for an admin, or for anyone when
// the study setting demoPublic is true. Otherwise FORBIDDEN (the session
// service enforces it).
//
// A demo session has no row in session_consents: that table holds the versioned
// research consent. The visitor's acceptance of the recording notice is stored
// in sessions.browser_info_json.demoAcknowledgement (time, notice version and
// notice text).
export async function startDemoSession(ctx: ServiceContext, input: StartDemoSessionInput): Promise<StartedDemoSession> {
  if (input.acknowledged !== true) {
    throw new AppError("VALIDATION_ERROR", "The recording notice must be accepted before a demo recording.", {
      reason: "demo_notice_not_accepted",
    });
  }
  const acknowledgement: DemoAcknowledgement = {
    acknowledgedAt: ctx.now().toISOString(),
    noticeVersion: demoSchemas.DEMO_RECORDING_NOTICE.version,
    noticeText: [...demoSchemas.DEMO_RECORDING_NOTICE.paragraphs],
  };
  const browserInfo: DemoBrowserInfo = { ...(input.browserInfo ?? {}), demoAcknowledgement: acknowledgement };
  const created = await createSession(ctx, {
    mode: "demo",
    locale: input.locale ?? null,
    browserInfo,
    callerIsAdmin: input.isAdmin,
    studySlug: input.studySlug,
  });
  return {
    session: created.session,
    token: created.token,
    tokenExpiresAt: created.tokenExpiresAt,
    info: {
      sessionId: created.session.id,
      participantCode: created.session.participantCode,
      acknowledgedAt: acknowledgement.acknowledgedAt,
      recordingCount: 0,
    },
  };
}

export function demoAcknowledgementOf(session: Pick<SessionRow, "browserInfoJson">): DemoAcknowledgement | null {
  const value = (session.browserInfoJson as DemoBrowserInfo | null)?.demoAcknowledgement;
  return value && typeof value.acknowledgedAt === "string" ? value : null;
}

// The open demo session of a demo cookie token, or null. A token of a research
// or test session is never accepted here, and neither is an ended session.
export async function findDemoSessionByToken(
  ctx: ServiceContext,
  token: string | null | undefined,
): Promise<SessionRow | null> {
  if (!token) return null;
  let session: SessionRow;
  try {
    session = await getSessionByToken(ctx, token);
  } catch (error) {
    if (isAppError(error) && error.code === "SESSION_EXPIRED") return null;
    throw error;
  }
  if (session.mode !== "demo" || isTerminalStatus(session.status)) return null;
  return session;
}

export async function getDemoSessionInfo(ctx: ServiceContext, session: SessionRow): Promise<demoSchemas.DemoSessionInfo> {
  const [row] = await ctx.db
    .select({ value: count() })
    .from(utterances)
    .where(eq(utterances.sessionId, session.id));
  return {
    sessionId: session.id,
    participantCode: session.participantCode,
    acknowledgedAt: demoAcknowledgementOf(session)?.acknowledgedAt ?? session.startedAt.toISOString(),
    recordingCount: row?.value ?? 0,
  };
}

// Throws unless the session is an open demo session. Used by every demo write.
export function assertOpenDemoSession(session: Pick<SessionRow, "mode" | "status">): void {
  if (session.mode !== "demo") {
    throw new AppError("FORBIDDEN", "This action is only available for a demo session.", { mode: session.mode });
  }
  if (isTerminalStatus(session.status)) {
    throw new AppError("SESSION_EXPIRED", "The demo session has ended. Please start again.");
  }
}

// Ends a demo session whose data is kept (demoPersist true): the session becomes
// `completed`, its token stops working, and its rows stay visible in the admin
// Sessions page with the DEMO badge.
export async function completeDemoSession(ctx: ServiceContext, sessionId: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const { session } = await lockSession(tx, sessionId);
    if (session.mode !== "demo") {
      throw new AppError("FORBIDDEN", "This action is only available for a demo session.", { mode: session.mode });
    }
    if (isTerminalStatus(session.status)) return;
    const now = ctx.now();
    await tx
      .update(sessionsTable)
      .set({ status: "completed", completedAt: now, lastActivityAt: now, tokenHash: null, tokenExpiresAt: null })
      .where(eq(sessionsTable.id, session.id));
  });
}

export async function loadStudyOfSession(ctx: ServiceContext, session: Pick<SessionRow, "studyId">): Promise<StudyRow> {
  const [study] = await ctx.db.select().from(studies).where(eq(studies.id, session.studyId)).limit(1);
  if (!study) throw new AppError("CONFIGURATION_MISSING", "The study of this session no longer exists.");
  return study;
}
