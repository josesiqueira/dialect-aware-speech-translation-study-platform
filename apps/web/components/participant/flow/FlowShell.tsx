"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DICTIONARIES, format, type Dictionary, type InterfaceLocale } from "@/lib/i18n";
import { ModeBanner } from "../Banners";
import { EndParticipationButton } from "../EndParticipationButton";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { ParticipantShell } from "../ParticipantShell";

/** The id of the h1 of every step. The page moves focus to it when the step changes. */
export const STEP_HEADING_ID = "step-heading";

/**
 * The language of the study texts (welcome, information, consent, task texts,
 * debrief), when the study declares it. Study texts are written by the
 * researchers in one language and are shown as they are, also when the
 * interface is in another language. When the two differ, the text must carry
 * its own `lang` (WCAG 3.1.2). The language is never guessed: undefined means
 * "not declared", and then no `lang` attribute is written.
 */
const ContentLanguageContext = createContext<string | undefined>(undefined);

/** `lang` value for an element that shows study content. Undefined when the study does not declare it. */
export function useContentLanguage(): string | undefined {
  return useContext(ContentLanguageContext);
}

export interface FlowShellProps {
  t: Dictionary;
  /** The interface language. Set as the `lang` of everything inside the shell. */
  locale: InterfaceLocale;
  /**
   * Declared language of the study texts (BCP 47), from the study settings when the API provides
   * it. StudyText and the headings that show protocol text use it as their `lang`. Leave unset
   * when it is not declared.
   */
  contentLang?: string;
  /** Languages the participant can choose. The buttons appear only when there is more than one. */
  locales: readonly InterfaceLocale[];
  onLocaleChange: (locale: InterfaceLocale) => void;
  /** Session mode. A banner is shown for "test" and "demo", never for "research". */
  mode?: "research" | "test" | "demo" | null;
  /** Task position, shown only during the tasks. */
  progress?: { taskNumber: number; totalTasks: number } | null;
  /** When set, the discreet "End participation" action is shown and calls this. */
  onEndParticipation?: () => void;
  /**
   * 3xl: the welcome page, as the reference landing page. 2xl: every step of
   * the study, which gives long texts a readable line length. md: the centered
   * final and message cards.
   */
  width?: "md" | "2xl" | "3xl";
  centered?: boolean;
  /** Replaces the mode banner, for example with the PreviewBanner of the admin preview. */
  banner?: ReactNode;
  children: ReactNode;
}

/**
 * The frame of every participant step: language attribute, mode banner,
 * language buttons, the "End participation" action and the task progress line.
 * Presentational: it holds no state and calls no API.
 */
export function FlowShell({
  t,
  locale,
  contentLang,
  locales,
  onLocaleChange,
  mode,
  progress,
  onEndParticipation,
  width = "2xl",
  centered = false,
  banner,
  children,
}: FlowShellProps) {
  const modeBanner =
    mode === "test" ? (
      <ModeBanner mode="TEST">{t.modeBanner.test}</ModeBanner>
    ) : mode === "demo" ? (
      <ModeBanner mode="DEMO">{t.modeBanner.demo}</ModeBanner>
    ) : undefined;

  return (
    <div lang={locale} data-testid="participant-flow">
      <ParticipantShell
        width={width}
        centered={centered}
        banner={banner ?? modeBanner}
        languageSwitcher={
          locales.length > 1 ? (
            <LanguageSwitcher
              languages={locales.map((code) => ({ code, label: DICTIONARIES[code].languageName }))}
              current={locale}
              onChange={(code) => {
                const next = locales.find((candidate) => candidate === code);
                if (next) onLocaleChange(next);
              }}
              groupLabel={t.common.languageGroupLabel}
            />
          ) : undefined
        }
        endAction={
          onEndParticipation ? (
            <EndParticipationButton onClick={onEndParticipation}>{t.endParticipation.action}</EndParticipationButton>
          ) : undefined
        }
        progress={
          progress
            ? {
                current: progress.taskNumber,
                total: progress.totalTasks,
                label: format(t.task.progress, { current: progress.taskNumber, total: progress.totalTasks }),
              }
            : undefined
        }
      >
        <ContentLanguageContext.Provider value={contentLang}>{children}</ContentLanguageContext.Provider>
      </ParticipantShell>
    </div>
  );
}
