// The title of the study that participants see (welcome heading, browser tab).
//
// It is separate from the internal study name (studies.name), which only the
// researchers see. The internal name may describe the research focus. The
// participant-facing title must not: naming the focus before the speech tasks
// would prime participants (spec 6.1, 6.4). It is stored in
// studies.settings_json under "participantTitle" and edited on the Settings page.
import type { StudySettings } from "@dialect/db";
import { protocolSchemas } from "@dialect/domain";

// Settings keys that the settings type of the database package does not list yet.
// participantTitleTranslations holds the title in other languages, keyed by locale.
export type StudySettingsWithTitle = StudySettings & {
  participantTitle?: string | null;
  participantTitleTranslations?: Record<string, string> | null;
};

// The stored title, or null when none is set.
export function participantTitleSetting(settings: StudySettings | null | undefined): string | null {
  const value = (settings as StudySettingsWithTitle | null | undefined)?.participantTitle;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// The stored translations of the title, without empty entries.
export function participantTitleTranslationsSetting(
  settings: StudySettings | null | undefined,
): Record<string, string> {
  const value = (settings as StudySettingsWithTitle | null | undefined)?.participantTitleTranslations;
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, title]) => typeof title === "string" && title.trim() !== "")
      .map(([locale, title]) => [locale, title.trim()]),
  );
}

// The title to show to participants, in the given locale when a translation is
// stored. Never the internal study name: when no title is set, a neutral one is used.
export function participantTitleOf(study: { settingsJson: StudySettings | null }, locale?: string | null): string {
  const base = participantTitleSetting(study.settingsJson);
  if (base === null) return protocolSchemas.neutralParticipantTitle(locale);
  return (locale ? participantTitleTranslationsSetting(study.settingsJson)[locale] : undefined) ?? base;
}
