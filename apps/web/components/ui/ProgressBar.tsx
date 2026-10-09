import { cn } from "./cn";

export interface ProgressBarProps {
  value: number;
  max: number;
  /** Accessible name, for example "Study progress". */
  label: string;
  className?: string;
}

/** Thin neutral progress bar. Orientation only: no points, no celebration. */
export function ProgressBar({ value, max, label, className }: ProgressBarProps) {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={clamped}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-slate-200", className)}
    >
      <div
        className="h-full rounded-full bg-slate-600 transition-[width] duration-200"
        style={{ width: `${(clamped / safeMax) * 100}%` }}
      />
    </div>
  );
}
