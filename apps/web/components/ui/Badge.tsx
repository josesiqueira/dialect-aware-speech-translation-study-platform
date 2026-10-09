import type { ReactNode } from "react";
import { cn } from "./cn";

export const BADGE_VARIANTS = [
  "neutral",
  "status",
  "completed",
  "verified",
  "needs-review",
  "warning",
  "test",
  "demo",
  "flagged",
  "error",
  "excluded",
  "incomplete",
] as const;

export type BadgeVariant = (typeof BADGE_VARIANTS)[number];

const sizeClasses = {
  sm: "px-1.5 py-0.5 text-[10px]",
  md: "px-2 py-0.5 text-xs",
} as const;

const emerald = "bg-emerald-50 text-emerald-700 border border-emerald-200";

const variantClasses: Record<BadgeVariant, string> = {
  neutral: "bg-slate-100 text-slate-700 border border-slate-200",
  status: emerald,
  completed: emerald,
  verified: emerald,
  "needs-review": "bg-amber-50 text-amber-800 border border-amber-200",
  warning: "bg-amber-100 text-amber-900 border border-amber-300",
  // Diagonal stripes: test data must be hard to mistake for research data.
  test: "bg-test-stripes text-amber-900 border border-amber-400 font-bold uppercase tracking-wide",
  // Distinct from TEST: solid blue tint with a dashed border.
  demo: "bg-blue-50 text-blue-800 border border-dashed border-blue-400 font-bold uppercase tracking-wide",
  flagged: "bg-rose-50 text-rose-700 border border-rose-200",
  error: "bg-rose-50 text-rose-700 border border-rose-300",
  excluded: "bg-slate-200 text-slate-600 border border-slate-300 line-through decoration-slate-400",
  incomplete: "bg-white text-slate-600 border border-dashed border-slate-400",
};

/** Small glyph before the text for variants where a second cue helps. Hidden from screen readers. */
const glyphs: Partial<Record<BadgeVariant, string>> = {
  verified: "✓",
  flagged: "⚑",
  error: "!",
};

export interface BadgeProps {
  /** The text is mandatory: a badge never communicates by color alone. */
  children: ReactNode;
  variant?: BadgeVariant;
  size?: "sm" | "md";
  className?: string;
  title?: string;
}

/** Compact pill for status, mode and review state. */
export function Badge({ children, variant = "neutral", size = "md", className, title }: BadgeProps) {
  const glyph = glyphs[variant];
  return (
    <span
      title={title}
      data-variant={variant}
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap",
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
    >
      {glyph && <span aria-hidden="true">{glyph}</span>}
      {children}
    </span>
  );
}
