"use client";

import { useCallback, useState } from "react";
import { errorMessage } from "../../_components/useApiResource";

/** Saves text as a file from the browser, without a server request. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after a tick so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function fileNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

export type ActionState = {
  busy: boolean;
  error: string | null;
  /** Runs the action. Returns true when it worked. */
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  clearError: () => void;
};

/** Pending and error state of one button-triggered request. */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { busy, error, run, clearError };
}

export function mediaUrl(mediaAssetId: string): string {
  return `/api/admin/media/${mediaAssetId}`;
}

export function mediaDownloadUrl(mediaAssetId: string): string {
  return `/api/admin/media/${mediaAssetId}/download`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
