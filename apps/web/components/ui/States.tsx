import type { ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";

export interface LoadingStateProps {
  /** Default "Loading...". */
  label?: string;
  /** md: h-64 for a page. sm: h-32 for a panel. inline: one line of text. */
  size?: "inline" | "sm" | "md";
  className?: string;
}

/**
 * Visually quiet loading text, as in the reference pages. Put aria-busy="true"
 * on the region that is being loaded.
 */
export function LoadingState({ label = "Loading...", size = "md", className }: LoadingStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center justify-center text-sm text-slate-500",
        size === "md" && "h-64",
        size === "sm" && "h-32",
        size === "inline" && "justify-start",
        className,
      )}
    >
      <span className="motion-safe:animate-pulse">{label}</span>
    </div>
  );
}

export interface EmptyStateProps {
  /** Short statement, for example "No sessions match the selected filters". */
  title: ReactNode;
  description?: ReactNode;
  /** Optional single action, for example a ClearFiltersButton. */
  action?: ReactNode;
  className?: string;
}

/** Plain centered text. Every list and table renders one instead of collapsing to nothing. */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("px-4 py-8 text-center", className)}>
      <p className="text-sm text-slate-600">{title}</p>
      {description && <p className="mt-1 text-xs text-slate-500">{description}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  /** Default "Something went wrong". */
  title?: ReactNode;
  /** Plain-language description of what failed. */
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/** Failure of a region to load. Shown in place; never a full-page takeover for a partial failure. */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Try again",
  className,
}: ErrorStateProps) {
  return (
    <div role="alert" className={cn("px-4 py-8 text-center", className)}>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {message && <p className="mt-1 text-sm text-slate-500">{message}</p>}
      {onRetry && (
        <div className="mt-4 flex justify-center">
          <Button onClick={onRetry}>{retryLabel}</Button>
        </div>
      )}
    </div>
  );
}
