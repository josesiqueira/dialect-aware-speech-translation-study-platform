// Study lookup and the operational settings that apply to participant sessions.
// Values come from studies.settings_json (spec 59). When a setting is missing
// there, the environment variable of spec 95 is used, then a built-in default.
import { asc, eq } from "drizzle-orm";
import { studies, type DbOrTx, type StudySettings } from "@dialect/db";
import {
  AppError,
  ENGLISH_CHECK_DEFAULT_ENABLED,
  OUTPUT_REVIEW_DEFAULT_MAX_ITEMS as REVIEW_DEFAULT_MAX_ITEMS,
} from "@dialect/domain";

export type StudyRow = typeof studies.$inferSelect;

export type EffectiveSettings = {
  allowNewSessions: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  maxUploadMb: number;
  maxUtteranceSeconds: number;
  sessionInactivityTimeoutMinutes: number;
  // Inactivity timeout of a session that never recorded consent (status
  // "created"). Short, so sessions that were opened and left (or created by a
  // script) do not stay open for hours. Key in studies.settings_json:
  // preConsentTimeoutMinutes. Default 30.
  preConsentTimeoutMinutes: number;
  sessionTokenTtlHours: number;
  studyLaptopMode: boolean;
  autoQueueAsr: boolean;
  demoPublic: boolean;
  participantLocales: string[];
  defaultLocale: string;
  // The output review at the end of a session (docs/RESEARCH-DESIGN.md, section 3).
  outputReviewEnabled: boolean;
  outputReviewMaxItems: number;
  englishCheckEnabled: boolean;
};

// Defaults of the output review (@dialect/domain, review-defaults.ts).
export const OUTPUT_REVIEW_DEFAULT_MAX_ITEMS = REVIEW_DEFAULT_MAX_ITEMS;
// The same limit as the settings form (corpusSchemas.OUTPUT_REVIEW_MAX_ITEMS_LIMIT).
export const OUTPUT_REVIEW_MAX_ITEMS_LIMIT = 20;

const BUILT_IN = {
  maxUploadMb: 100,
  maxUtteranceSeconds: 300,
  sessionInactivityTimeoutMinutes: 120,
  preConsentTimeoutMinutes: 30,
  sessionTokenTtlHours: 24,
} as const;

// Language of the participant interface when the study settings name no locale
// at all. It only selects the interface dictionary (buttons, error messages).
// It says nothing about the study content, which comes from the protocol.
export const INTERFACE_FALLBACK_LOCALE = "en";

function positive(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : null;
}

export function effectiveSettings(
  settings: StudySettings,
  env: Record<string, string | undefined> = process.env,
): EffectiveSettings {
  const locales = (settings.participantLocales ?? []).filter((locale) => typeof locale === "string" && locale);
  // The default interface language is one of the offered locales: the configured
  // default when it is offered (or when nothing is offered), otherwise the first
  // offered locale.
  const configured = settings.defaultLocale || null;
  const defaultLocale =
    configured && (locales.length === 0 || locales.includes(configured))
      ? configured
      : (locales[0] ?? INTERFACE_FALLBACK_LOCALE);
  return {
    // Not set means closed: collecting research data is an explicit decision of
    // the researchers (Settings page), never a default.
    allowNewSessions: settings.allowNewSessions === true,
    maintenanceMode: settings.maintenanceMode ?? false,
    maintenanceMessage: settings.maintenanceMessage || null,
    maxUploadMb: positive(settings.maxUploadMb) ?? positive(env.MAX_AUDIO_UPLOAD_MB) ?? BUILT_IN.maxUploadMb,
    maxUtteranceSeconds:
      positive(settings.maxUtteranceSeconds) ?? positive(env.MAX_UTTERANCE_SECONDS) ?? BUILT_IN.maxUtteranceSeconds,
    sessionInactivityTimeoutMinutes:
      positive(settings.sessionInactivityTimeoutMinutes) ?? BUILT_IN.sessionInactivityTimeoutMinutes,
    // The key is not part of the StudySettings type yet (the type lives in the
    // database package), so it is read through a widened type.
    preConsentTimeoutMinutes:
      positive((settings as StudySettings & { preConsentTimeoutMinutes?: unknown }).preConsentTimeoutMinutes) ??
      BUILT_IN.preConsentTimeoutMinutes,
    sessionTokenTtlHours: positive(env.PARTICIPANT_SESSION_TTL_HOURS) ?? BUILT_IN.sessionTokenTtlHours,
    studyLaptopMode: settings.studyLaptopMode ?? false,
    autoQueueAsr: settings.autoQueueAsr ?? false,
    demoPublic: settings.demoPublic ?? false,
    participantLocales: locales.length > 0 ? locales : [defaultLocale],
    defaultLocale,
    outputReviewEnabled: settings.outputReviewEnabled ?? true,
    outputReviewMaxItems: Math.min(
      Math.floor(positive(settings.outputReviewMaxItems) ?? OUTPUT_REVIEW_DEFAULT_MAX_ITEMS),
      OUTPUT_REVIEW_MAX_ITEMS_LIMIT,
    ),
    // Off unless a researcher turns it on (docs/IMPLEMENTATION-STATUS.md, "Deviations").
    englishCheckEnabled: settings.englishCheckEnabled ?? ENGLISH_CHECK_DEFAULT_ENABLED,
  };
}

// The deployment runs one study. Without a slug this returns the study that was
// created first. Tests and later multi-study setups pass the slug.
export async function resolveStudy(db: DbOrTx, studySlug?: string | null): Promise<StudyRow> {
  const rows = studySlug
    ? await db.select().from(studies).where(eq(studies.slug, studySlug)).limit(1)
    : await db.select().from(studies).orderBy(asc(studies.createdAt), asc(studies.id)).limit(1);
  const study = rows[0];
  if (!study) {
    throw new AppError("CONFIGURATION_MISSING", "No study is configured on this server.");
  }
  return study;
}

export const STUDY_CLOSED_MESSAGE = "This study is not currently accepting new participants.";
export const MAINTENANCE_MESSAGE = "The study is temporarily unavailable. Please try again later.";
