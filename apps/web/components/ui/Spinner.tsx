import { cn } from "./cn";

export interface SpinnerProps {
  size?: "sm" | "md";
  className?: string;
  /** Accessible name. Omit when a visible label next to the spinner already says what is happening. */
  label?: string;
}

/** Compact spinner, the same drawing as the reference SaveButton. Stops under prefers-reduced-motion. */
export function Spinner({ size = "sm", className, label }: SpinnerProps) {
  return (
    <svg
      className={cn(
        "motion-safe:animate-spin shrink-0",
        size === "sm" ? "h-4 w-4" : "h-5 w-5",
        className,
      )}
      viewBox="0 0 24 24"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
