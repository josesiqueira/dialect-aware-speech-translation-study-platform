import { useId, type ReactNode } from "react";
import { cn } from "./cn";
import { overlineLabel } from "./styles";

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  /** Optional muted line under the value, for example "excluding TEST and DEMO". */
  subtitle?: ReactNode;
  /** Optional explanation shown on hover and on keyboard focus of the "?" control. */
  tooltip?: string;
  /**
   * Where the tooltip opens from the "?" control. center (default): centered under it. end: its
   * right edge is aligned with the control and it opens to the left. Use "end" for a card in the
   * last column of a grid, where a centered tooltip would reach past the edge of the page.
   */
  tooltipAlign?: "center" | "end";
  /** Color of the value. Use only when the number itself is a state (for example flagged > 0). */
  accent?: "default" | "danger" | "success" | "info";
  /** default: p-5 and text-3xl (reference MetricCard). compact: p-4 and text-2xl (reference dashboard grid). */
  density?: "default" | "compact";
  className?: string;
}

const accentClasses = {
  default: "text-slate-900",
  danger: "text-rose-600",
  success: "text-emerald-600",
  info: "text-blue-600",
} as const;

/** Single headline number: small uppercase muted label, monospace tabular value. */
export function MetricCard({
  label,
  value,
  subtitle,
  tooltip,
  tooltipAlign = "center",
  accent = "default",
  density = "default",
  className,
}: MetricCardProps) {
  const tooltipId = useId();
  const compact = density === "compact";
  return (
    <article
      className={cn(
        "relative rounded-lg border border-slate-200 bg-white shadow-sm",
        compact ? "p-4" : "p-5",
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        <p className={overlineLabel}>{label}</p>
        {tooltip && (
          <span className="group relative inline-flex">
            <button
              type="button"
              aria-label={`About ${label}`}
              aria-describedby={tooltipId}
              className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-slate-300 text-[10px] font-semibold leading-none text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              ?
            </button>
            <span
              id={tooltipId}
              role="tooltip"
              className={cn(
                "pointer-events-none absolute top-full z-10 mt-1 w-56 rounded-md bg-slate-900 px-2.5 py-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-white opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100",
                tooltipAlign === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
              )}
            >
              {tooltip}
            </span>
          </span>
        )}
      </div>
      <p
        className={cn(
          "font-mono font-semibold tabular-nums",
          compact ? "mt-1 text-2xl" : "mt-2 text-3xl",
          accentClasses[accent],
        )}
      >
        {value}
      </p>
      {subtitle && <p className="mt-1 text-xs text-slate-500 tabular-nums">{subtitle}</p>}
    </article>
  );
}
