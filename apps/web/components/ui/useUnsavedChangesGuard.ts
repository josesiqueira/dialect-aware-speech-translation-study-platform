"use client";

import { useEffect } from "react";

export const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes. Leave this page and discard them?";

/**
 * Warn before unsaved edits are lost (spec 129). Grown from the reference
 * useUnsavedChanges hook, which handled only the browser case.
 *
 * While `isDirty` is true:
 * 1. closing the tab, reloading or typing a new address shows the browser's
 *    own "Leave site?" dialog (beforeunload; browsers fix the text);
 * 2. a click on an in-app link (the sidebar, a breadcrumb, any <a> to the same
 *    origin) asks for confirmation first and is cancelled if the researcher
 *    declines. The listener runs in the capture phase on the document, before
 *    the Next.js Link handler, so a declined navigation never starts.
 *
 * Not covered: the browser Back and Forward buttons within the app, and
 * navigation started in code. Before calling router.push from an editor,
 * call `confirmDiscardChanges(isDirty)`.
 */
export function useUnsavedChangesGuard(isDirty: boolean, message: string = UNSAVED_CHANGES_MESSAGE): void {
  useEffect(() => {
    if (!isDirty) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Required for the prompt to show in some browsers.
      event.returnValue = "";
    };

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      // Modified clicks open a new tab or window: this page stays, nothing is lost.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      if (target.target && target.target !== "_self") return;
      if (target.hasAttribute("download")) return;
      const url = new URL(target.href, window.location.href);
      if (url.origin !== window.location.origin) return; // beforeunload covers this
      const samePage = url.pathname === window.location.pathname && url.search === window.location.search;
      if (samePage) return; // an anchor inside the page
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [isDirty, message]);
}

/** For navigation started in code. Returns true when it is safe to leave. */
export function confirmDiscardChanges(isDirty: boolean, message: string = UNSAVED_CHANGES_MESSAGE): boolean {
  return !isDirty || window.confirm(message);
}
