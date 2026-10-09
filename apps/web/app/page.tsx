import { cookies } from "next/headers";
import type { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { availableLocales, LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";
import { getServiceContext } from "@/lib/server/context";
import { readParticipantToken } from "@/lib/server/participant-cookie";
import { WelcomeEntry } from "./study/_components/WelcomeEntry";

const ENDED = new Set(["completed", "withdrawn", "abandoned"]);

/** True when the cookie of this browser leads to a session that has not ended. Reads only. */
async function hasRunningSession(): Promise<boolean> {
  try {
    const token = await readParticipantToken();
    if (!token) return false;
    const session = await sessions.getSessionByToken(getServiceContext(), token);
    return !ENDED.has(session.status);
  } catch {
    // No usable session (expired, unknown token). The session API clears the cookie on the next call.
    return false;
  }
}

/**
 * Welcome page (spec 6.1). The server loads the public study information, so
 * the study name and the welcome text are in the first response. The client
 * part (WelcomeEntry) holds the language buttons and the Begin action.
 *
 * `?mode=test` is the researcher test entry. It only selects the mode asked
 * for when the session is created. The server refuses it without an admin
 * session, and the mode of an existing session is never taken from the URL.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { mode } = await searchParams;
  const cookieStore = await cookies();

  let info: sessionSchemas.StudyInfoResponse | null = null;
  try {
    info = await sessions.getPublicStudyInfo(getServiceContext());
  } catch {
    // Shown as a calm "something went wrong" card with a retry. No detail reaches the page.
    info = null;
  }

  const studyLocales = info?.locales ?? [];
  const initialLocale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, studyLocales, info?.defaultLocale);
  const locales = availableLocales(studyLocales);

  return (
    <WelcomeEntry
      info={info}
      locales={locales.length > 0 ? locales : [initialLocale]}
      initialLocale={initialLocale}
      hasRunningSession={info ? await hasRunningSession() : false}
      testEntry={mode === "test"}
    />
  );
}
