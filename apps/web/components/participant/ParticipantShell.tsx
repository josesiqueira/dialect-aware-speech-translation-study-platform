import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { ProgressBar } from "@/components/ui/ProgressBar";

export interface ParticipantProgress {
  /** Position in the sequence, starting at 1. */
  current: number;
  total: number;
  /** The whole visible line, already localized, for example "Task 2 of 7" or "Tehtävä 2/7". */
  label: string;
  /** Show the thin neutral bar under the line. Default true. */
  showBar?: boolean;
}

export interface ParticipantShellProps {
  children: ReactNode;
  /** 3xl: welcome and consent. 2xl: tasks and questionnaires. md: centered transition and completion cards. */
  width?: "md" | "2xl" | "3xl";
  /** Center the content vertically (transition, thank-you). */
  centered?: boolean;
  /** Slot for the compact language buttons (LanguageSwitcher). */
  languageSwitcher?: ReactNode;
  /** Slot for the discreet "End participation" action (EndParticipationButton). */
  endAction?: ReactNode;
  /** "Task 2 of 7" with a thin bar. Orientation only. */
  progress?: ParticipantProgress;
  /** Full-width banner above everything: ModeBanner or PreviewBanner. */
  banner?: ReactNode;
  className?: string;
}

const widthClasses = {
  md: "max-w-md",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
} as const;

/**
 * ParticipantShell: the calm, sequential frame of every participant page.
 * From the reference participant pages: min-h-screen, a subtle slate-50 to
 * white background, centered narrow content, px-4, py-8 (py-6 on small screens).
 */
export function ParticipantShell({
  children,
  width = "2xl",
  centered = false,
  languageSwitcher,
  endAction,
  progress,
  banner,
  className,
}: ParticipantShellProps) {
  const hasTopRow = Boolean(languageSwitcher || endAction);
  return (
    <div className="flex min-h-screen flex-col bg-linear-to-b from-slate-50 to-white text-slate-700">
      {banner}
      <div
        className={cn(
          "mx-auto flex w-full flex-1 flex-col px-4 py-6 sm:py-8",
          widthClasses[width],
          className,
        )}
      >
        {hasTopRow && (
          <header className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">{endAction}</div>
            <div className="flex shrink-0 justify-end gap-1">{languageSwitcher}</div>
          </header>
        )}
        <main id="main-content" className={cn("flex-1", centered && "flex flex-col justify-center")}>
          {/* Inside main, so the progress line belongs to a landmark. */}
          {progress && (
            <div className="mb-6">
              <p className="mb-1.5 text-sm font-medium text-slate-500 tabular-nums">{progress.label}</p>
              {progress.showBar !== false && (
                <ProgressBar value={progress.current} max={progress.total} label={progress.label} />
              )}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
