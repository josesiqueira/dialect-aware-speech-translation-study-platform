// Interface languages of the participant flow (spec 100). No library: one typed
// object per language. How to add a language: docs/PARTICIPANT-UI.md.
//
// This folder has no "use client" and imports no client module at run time, so
// server components and client components can both use it.
import type { MicCheckLabels, RecordingTaskLabels } from "@/components/participant/recorder/labels";
import { en } from "./en";
import { fi } from "./fi";
import type { Dictionary, ErrorMessageKey } from "./types";

export type { Dictionary, ErrorMessageKey, ParticipantErrorCode } from "./types";

/** The languages the interface exists in. A study chooses among them in its settings. */
export const DICTIONARIES = { en, fi } as const satisfies Record<string, Dictionary>;
export type InterfaceLocale = keyof typeof DICTIONARIES;
export const INTERFACE_LOCALES = Object.keys(DICTIONARIES) as InterfaceLocale[];

/** Used when a study names no language that the interface has. */
export const FALLBACK_LOCALE: InterfaceLocale = "en";

/**
 * Name of the cookie that keeps the participant's language choice for the
 * session. It holds only a language code, is readable by scripts on purpose and
 * is removed when the session ends (spec 138).
 */
export const LOCALE_COOKIE = "dts_locale";

export function isInterfaceLocale(value: unknown): value is InterfaceLocale {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DICTIONARIES, value);
}

/** "fi-FI" and "FI" both match "fi". Returns null for a language the interface does not have. */
export function matchInterfaceLocale(value: string | null | undefined): InterfaceLocale | null {
  if (!value) return null;
  const primary = value.trim().toLowerCase().split("-")[0];
  return isInterfaceLocale(primary) ? primary : null;
}

/** The study's locales that the interface has, in the study's order, without duplicates. */
export function availableLocales(studyLocales: readonly string[]): InterfaceLocale[] {
  const result: InterfaceLocale[] = [];
  for (const locale of studyLocales) {
    const match = matchInterfaceLocale(locale);
    if (match && !result.includes(match)) result.push(match);
  }
  return result;
}

/**
 * The language to show: the participant's choice when the study offers it, else
 * the study default, else the first language the study offers, else English.
 */
export function resolveLocale(
  requested: string | null | undefined,
  studyLocales: readonly string[],
  defaultLocale: string | null | undefined,
): InterfaceLocale {
  const available = availableLocales(studyLocales);
  const wanted = matchInterfaceLocale(requested);
  if (wanted && available.includes(wanted)) return wanted;
  const preferred = matchInterfaceLocale(defaultLocale);
  if (preferred && (available.length === 0 || available.includes(preferred))) return preferred;
  return available[0] ?? FALLBACK_LOCALE;
}

export function getDictionary(locale: string | null | undefined): Dictionary {
  return DICTIONARIES[matchInterfaceLocale(locale) ?? FALLBACK_LOCALE];
}

/** Replaces {name} placeholders. A placeholder without a value is left as it is. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

/**
 * The browser tab title of a participant screen: the step name, then the
 * participant-facing study title ("Consent | Study title"). The separator is
 * the one of the title template in app/layout.tsx. Without a study title the
 * step name stands alone.
 */
export function pageTitle(stepName: string, studyTitle: string | null | undefined): string {
  const study = studyTitle?.trim();
  return study ? `${stepName} | ${study}` : stepName;
}

const ERROR_KEYS: ReadonlySet<string> = new Set<ErrorMessageKey>([
  "MICROPHONE_PERMISSION_DENIED",
  "RECORDING_FAILED",
  "UPLOAD_FAILED",
  "SESSION_EXPIRED",
  "STUDY_CLOSED",
  "NETWORK_ERROR",
  "RATE_LIMITED",
  "FORBIDDEN",
  "INVALID_AUDIO",
  "PAYLOAD_TOO_LARGE",
  "VALIDATION_ERROR",
  "UNEXPECTED",
]);

/** The dictionary key for an error code of the API client. Unknown codes map to "UNEXPECTED". */
export function errorMessageKey(code: string | null | undefined): ErrorMessageKey {
  return code && ERROR_KEYS.has(code) ? (code as ErrorMessageKey) : "UNEXPECTED";
}

/**
 * Plain-language text for a failure. Only dictionary text is returned: server
 * messages, stack traces and provider messages never reach the participant.
 */
export function errorMessage(dictionary: Dictionary, code: string | null | undefined): string {
  return dictionary.errors[errorMessageKey(code)];
}

/** The complete label object for the RecordingTask component. */
export function recordingTaskLabels(dictionary: Dictionary): RecordingTaskLabels {
  return { ...dictionary.task.recording, errors: dictionary.recorderErrors };
}

/** The complete label object for the MicCheck component. */
export function micCheckLabels(dictionary: Dictionary): MicCheckLabels {
  return { ...dictionary.micCheck.labels, errors: dictionary.recorderErrors };
}

/** A suggested duration in words, for example "30 seconds" or "2 minutes". */
export function durationText(dictionary: Dictionary, totalSeconds: number): string {
  const whole = Math.max(1, Math.round(totalSeconds));
  if (whole < 60) return format(dictionary.task.durationSeconds, { count: whole });
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  if (seconds !== 0) return format(dictionary.task.durationMinutesSeconds, { minutes, seconds });
  if (minutes === 1) return dictionary.task.durationOneMinute;
  return format(dictionary.task.durationMinutes, { count: minutes });
}
