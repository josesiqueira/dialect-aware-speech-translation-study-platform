// What the participant pages keep in the browser, and how it is removed.
//
// The pages keep one thing outside React memory: the language choice, in the
// cookie LOCALE_COOKIE (a language code, nothing else). The session itself is
// the HttpOnly cookie that only the server reads and clears. Nothing is written
// to localStorage. sessionStorage is not used either, and is cleared at the end
// of a session anyway, so that later code cannot leave something behind.
import { LOCALE_COOKIE, pageTitle, type InterfaceLocale } from "@/lib/i18n";

/**
 * Sets the browser tab title of a participant screen (WCAG 2.4.2): the step
 * name in the interface language, then the participant-facing study title.
 * The title holds interface words and that study title only, never a task
 * text or anything else of the session.
 */
export function showPageTitle(stepName: string, studyTitle: string | null | undefined): void {
  document.title = pageTitle(stepName, studyTitle);
}

/** Keeps the language choice for this browser session (a session cookie: it ends with the browser). */
export function rememberLocale(locale: InterfaceLocale): void {
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; SameSite=Lax`;
}

export function forgetLocale(): void {
  document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Removes everything the pages stored in the browser (spec 137, 138). Called
 * when a session is completed, withdrawn or expired. Recordings, blob URLs and
 * the microphone belong to the recorder components, which release them when
 * they unmount, and the server clears the session cookie.
 */
export function clearClientState(): void {
  forgetLocale();
  try {
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable (blocked by a browser setting). Nothing was stored then.
  }
}

/**
 * Leaves the study page with a full page load. A full load, not a client-side
 * navigation, so that every piece of React state of the finished session is
 * dropped and the next person starts from a clean page.
 */
export function leaveToWelcome(): void {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/");
}
