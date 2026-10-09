import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessions } from "@dialect/research";
import { availableLocales, LOCALE_COOKIE, matchInterfaceLocale, resolveLocale } from "@/lib/i18n";
import { getServiceContext } from "@/lib/server/context";
import { readParticipantToken } from "@/lib/server/participant-cookie";
import { StudyFlow } from "./_components/StudyFlow";

/**
 * The study page (spec 107): one page for every step after the welcome page.
 * The step is decided by the server and loaded by StudyFlow from
 * GET /api/study/session. Nothing about the study is in the URL (spec 61).
 *
 * A browser without a session cookie is sent back to the welcome page at once.
 * A cookie that no longer leads to a session is handled by StudyFlow.
 */
export default async function StudyPage() {
  if (!(await readParticipantToken())) redirect("/");

  const cookieStore = await cookies();
  let studyLocales: string[] = [];
  let defaultLocale: string | null = null;
  try {
    const info = await sessions.getPublicStudyInfo(getServiceContext());
    studyLocales = info.locales;
    defaultLocale = info.defaultLocale;
  } catch {
    // The page still works: StudyFlow shows its own error state if the API cannot be reached.
  }

  const stored = cookieStore.get(LOCALE_COOKIE)?.value;
  const initialLocale = resolveLocale(stored, studyLocales, defaultLocale);
  const locales = availableLocales(studyLocales);
  const chosen = matchInterfaceLocale(stored);

  return (
    <StudyFlow
      locales={locales.length > 0 ? locales : [initialLocale]}
      initialLocale={initialLocale}
      localeChosen={chosen !== null && chosen === initialLocale}
    />
  );
}
