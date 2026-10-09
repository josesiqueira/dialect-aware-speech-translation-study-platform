"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, isApiClientError } from "@/lib/client/api";

export type ApiResource<T> = {
  /** The last loaded value. Stays visible while the same URL is loaded again. */
  data: T | null;
  /** Error text of the last load, null when it worked. */
  error: string | null;
  /** True until the current request has an answer. */
  loading: boolean;
  /** When the shown data arrived. */
  loadedAt: Date | null;
  /** Loads the same URL again. Resolves when the new answer is in. */
  reload: () => Promise<void>;
};

type Loaded<T> = { url: string; version: number; data: T | null; error: string | null; at: Date };

export function errorMessage(error: unknown): string {
  if (isApiClientError(error)) {
    // A validation error names the fields that were not accepted.
    const issues = (error.details as { issues?: Array<{ path?: string; message?: string }> } | undefined)?.issues;
    if (error.code === "VALIDATION_ERROR" && Array.isArray(issues) && issues.length > 0) {
      const text = issues
        .map((issue) => (issue.path ? `${issue.path}: ${issue.message ?? "not valid"}` : (issue.message ?? "not valid")))
        .join("; ");
      return `${error.message} ${text}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "The request failed.";
}

/**
 * Loads JSON from one of the app's own API routes and keeps it in state.
 * Pass null to load nothing. A changed URL starts a new request and cancels
 * the one in flight.
 */
export function useApiResource<T>(url: string | null): ApiResource<T> {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const [version, setVersion] = useState(0);
  const [waiters] = useState<Array<() => void>>(() => []);

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    const finish = () => {
      for (const resolve of waiters.splice(0)) resolve();
    };
    apiFetch<T>(url, { signal: controller.signal })
      .then((data) => {
        setLoaded({ url, version, data, error: null, at: new Date() });
        finish();
      })
      .catch((error: unknown) => {
        if (isApiClientError(error) && error.code === "ABORTED") return;
        setLoaded((previous) => ({
          url,
          version,
          // Keep the last good data of the same URL on screen next to the error.
          data: previous && previous.url === url ? previous.data : null,
          error: errorMessage(error),
          at: previous && previous.url === url ? previous.at : new Date(),
        }));
        finish();
      });
    return () => controller.abort();
  }, [url, version, waiters]);

  const reload = useCallback(
    () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
        setVersion((value) => value + 1);
      }),
    [waiters],
  );

  const sameUrl = loaded !== null && loaded.url === url;
  const current = sameUrl && loaded.version === version;
  return {
    data: sameUrl ? loaded.data : null,
    error: current ? loaded.error : null,
    loading: url !== null && !current,
    loadedAt: sameUrl && loaded.data !== null ? loaded.at : null,
    reload,
  };
}
