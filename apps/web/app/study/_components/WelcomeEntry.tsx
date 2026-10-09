"use client";

/**
 * WelcomeEntry: the client part of the welcome page "/". The server component
 * app/page.tsx loads the public study information and renders this with it.
 *
 * "Begin" creates the session (or resumes the running one of this browser) and
 * opens /study. No study state is put into the URL (spec 61).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { sessionSchemas } from "@dialect/domain";
import { isApiClientError } from "@/lib/client/api";
import { FlowShell, MessageScreen, WelcomeStep } from "@/components/participant/flow";
import { errorMessage, getDictionary, type InterfaceLocale } from "@/lib/i18n";
import { rememberLocale, showPageTitle } from "../_lib/clientState";
import { browserInfo, errorCodeOf, maintenanceMessageOf, participantApi } from "../_lib/participantApi";

export interface WelcomeEntryProps {
  /** Public study information. Null when it could not be loaded. */
  info: sessionSchemas.StudyInfoResponse | null;
  locales: InterfaceLocale[];
  initialLocale: InterfaceLocale;
  /** This browser has a session that has not ended. "Begin" continues it. */
  hasRunningSession: boolean;
  /**
   * Researcher test entry (/?mode=test). The server honors it only for a
   * signed-in admin. It is used for the session creation request only and is
   * never read again once the session exists.
   */
  testEntry: boolean;
}

type Problem = { code: string; text: string | null };

export function WelcomeEntry({ info, locales, initialLocale, hasRunningSession, testEntry }: WelcomeEntryProps) {
  const router = useRouter();
  const [locale, setLocale] = useState<InterfaceLocale>(initialLocale);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [closedNow, setClosedNow] = useState<string | null>(null);
  const t = getDictionary(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // The browser tab title: the name of this screen in the interface language, then the study title.
  // The title and the welcome text in the chosen language (the base text when there is no translation).
  const studyTitle = info ? (info.studyNameByLocale[locale] ?? info.studyName) : null;
  const welcomeContent = info ? (info.welcomeContentByLocale[locale] ?? info.welcomeContent) : null;
  const screenName = info ? t.pageTitle.welcome : t.pageTitle.error;
  useEffect(() => {
    showPageTitle(screenName, studyTitle);
  }, [screenName, studyTitle]);

  const changeLocale = (next: InterfaceLocale) => {
    setLocale(next);
    rememberLocale(next);
  };

  const shell = { t, locale, locales, onLocaleChange: changeLocale };

  if (!info) {
    return (
      <FlowShell {...shell} width="md" centered>
        <MessageScreen
          title={t.errorScreens.genericTitle}
          message={t.errors.UNEXPECTED}
          actionLabel={t.common.tryAgain}
          onAction={() => window.location.reload()}
        />
      </FlowShell>
    );
  }

  const begin = async () => {
    setBusy(true);
    setProblem(null);
    try {
      rememberLocale(locale);
      const created = await participantApi.createSession({
        locale,
        browserInfo: browserInfo(),
        ...(testEntry ? { mode: "test" as const } : {}),
      });
      if (testEntry && created.state.mode !== "test") {
        // A running session of another mode was resumed. It is left untouched
        // and the researcher is told, so a test run never continues real data.
        setProblem({ code: "FORBIDDEN", text: "testEntryBlocked" });
        setBusy(false);
        return;
      }
      router.push("/study");
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "STUDY_CLOSED") {
        setClosedNow(maintenanceMessageOf(error) ?? "");
      } else if (testEntry && isApiClientError(error) && error.code === "FORBIDDEN") {
        setProblem({ code, text: "testEntryNotAllowed" });
      } else {
        setProblem({ code, text: null });
      }
      setBusy(false);
    }
  };

  // The text shown in place of the button when the study takes no new participants (spec 87).
  // Maintenance mode shows the researchers' own message. Every other reason shows the fixed sentence.
  let closedMessage: string | null = null;
  if (closedNow !== null) {
    closedMessage = closedNow || t.welcome.studyClosed;
  } else if (!info.acceptingNewSessions && !testEntry) {
    closedMessage =
      info.closedReason === "maintenance" && info.closedMessage ? info.closedMessage : t.welcome.studyClosed;
  }

  const problemText = !problem
    ? null
    : problem.text === "testEntryBlocked"
      ? t.welcome.testEntryBlocked
      : problem.text === "testEntryNotAllowed"
        ? t.welcome.testEntryNotAllowed
        : errorMessage(t, problem.code);

  return (
    <FlowShell {...shell} width="3xl">
      <WelcomeStep
        t={t}
        studyName={studyTitle ?? info.studyName}
        welcomeContent={welcomeContent}
        closedMessage={closedMessage}
        resumable={hasRunningSession && closedNow === null}
        notice={testEntry ? t.welcome.testEntryNote : null}
        error={problemText}
        busy={busy}
        onBegin={() => void begin()}
      />
    </FlowShell>
  );
}
