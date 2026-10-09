"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "./cn";
import { focusRing } from "./styles";

export interface RefreshButtonProps {
  onRefresh: () => void | Promise<void>;
  /** When the data was last loaded. null shows "never". */
  lastUpdated: Date | null;
  /** Error text from the last refresh, shown inline. */
  error?: string | null;
  /** Pass both auto-refresh props to show the checkbox. The parent owns the interval. */
  isAutoRefreshing?: boolean;
  onToggleAutoRefresh?: (value: boolean) => void;
  /** Interval shown in the checkbox label, in seconds. Default 10. */
  autoRefreshSeconds?: number;
  className?: string;
}

/**
 * Compact dashboard control (reference RefreshButton): "Last updated" time,
 * manual Refresh, optional auto-refresh checkbox. The parent owns the fetch.
 */
export function RefreshButton({
  onRefresh,
  lastUpdated,
  error,
  isAutoRefreshing,
  onToggleAutoRefresh,
  autoRefreshSeconds = 10,
  className,
}: RefreshButtonProps) {
  // Re-render every 10 seconds so the relative time stays current without a refetch.
  const [now, setNow] = useState<number>(() => Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
      setNow(Date.now());
    }
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-3 text-xs text-slate-500", className)}>
      {error ? (
        <span role="alert" className="text-rose-700">
          {error}
        </span>
      ) : (
        <span className="tabular-nums">
          Last updated {lastUpdated ? formatRelativeTime(lastUpdated, now) : "never"}
        </span>
      )}

      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        aria-busy={busy || undefined}
        className={cn(
          "inline-flex items-center gap-1 rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50",
          focusRing,
        )}
      >
        <span aria-hidden="true" className={cn("inline-block", busy && "motion-safe:animate-spin")}>
          {"↻"}
        </span>
        {busy ? "Refreshing..." : "Refresh"}
      </button>

      {onToggleAutoRefresh && (
        <label className="inline-flex cursor-pointer select-none items-center gap-1.5">
          <input
            type="checkbox"
            checked={Boolean(isAutoRefreshing)}
            onChange={(event) => onToggleAutoRefresh(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300 accent-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          />
          <span>Auto-refresh ({autoRefreshSeconds}s)</span>
        </label>
      )}
    </div>
  );
}
