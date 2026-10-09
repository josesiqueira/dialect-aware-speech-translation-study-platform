"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "./cn";
import { IconCheck, IconCopy } from "./icons";

export interface CopyableIdProps {
  /** The full identifier. This is what gets copied. */
  value: string;
  /** What the identifier is, for the accessible name: "session id", "utterance id". */
  label?: string;
  /** Show only the first N characters (the full value stays in the title and is still copied). */
  truncate?: number;
  className?: string;
}

/** Monospace identifier with a copy button and a polite "Copied" confirmation. */
export function CopyableId({ value, label = "id", truncate, className }: CopyableIdProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 2000);
  }

  const shown = truncate !== undefined && value.length > truncate ? value.slice(0, truncate) : value;

  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 align-middle", className)}>
      <code className="truncate font-mono text-xs text-slate-600" title={value}>
        {shown}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        {status === "copied" ? <IconCheck className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
      </button>
      <span role="status" className={cn("text-xs", status === "failed" ? "text-rose-700" : "text-emerald-700")}>
        {status === "copied" && "Copied"}
        {status === "failed" && "Copy failed"}
      </span>
    </span>
  );
}
