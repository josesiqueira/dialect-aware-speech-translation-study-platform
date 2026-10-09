import { cn } from "@/components/ui/cn";

export interface LevelMeterProps {
  /** Peak of the latest audio block, 0 to 1. Null renders an empty meter. */
  level: number | null;
  className?: string;
}

/** The meter shows the range from -60 dBFS (empty) to 0 dBFS (full). */
const FLOOR_DB = -60;

/** Peak amplitude to a bar width between 0 and 1 on a decibel scale. */
export function levelToFraction(level: number | null): number {
  if (typeof level !== "number" || !(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

/**
 * Restrained input level bar (spec 0B.4): neutral slate, no color coding, no
 * waveform. It only shows that the microphone delivers a signal. It is
 * decorative for assistive technology: nothing here is announced, and it says
 * nothing about the speech itself.
 */
export function LevelMeter({ level, className }: LevelMeterProps) {
  return (
    <div
      aria-hidden="true"
      data-testid="level-meter"
      className={cn("h-1.5 w-40 overflow-hidden rounded-full bg-slate-200", className)}
    >
      <div className="h-full rounded-full bg-slate-500" style={{ width: `${levelToFraction(level) * 100}%` }} />
    </div>
  );
}
