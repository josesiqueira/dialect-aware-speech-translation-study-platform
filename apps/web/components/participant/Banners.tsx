import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export interface ModeBannerProps {
  mode: "TEST" | "DEMO";
  /** Explanation after the mode name. A default is provided for each mode. */
  children?: ReactNode;
  className?: string;
}

const defaultText: Record<ModeBannerProps["mode"], string> = {
  TEST: "Test session. Nothing recorded here is research data.",
  DEMO: "Demonstration. Recordings are processed immediately and are not research data.",
};

/**
 * Full-width banner that stays at the top of the screen while a TEST or DEMO
 * session is shown. TEST uses the striped amber treatment of the TEST badge;
 * DEMO uses blue with a dashed edge. The mode name is always written out.
 */
export function ModeBanner({ mode, children, className }: ModeBannerProps) {
  return (
    <div
      role="region"
      aria-label={`${mode} mode`}
      data-mode={mode}
      className={cn(
        "sticky top-0 z-20 w-full border-b-2 px-4 py-2 text-center text-sm",
        mode === "TEST"
          ? "bg-test-stripes border-amber-500 text-amber-950"
          : "border-dashed border-blue-500 bg-blue-50 text-blue-900",
        className,
      )}
    >
      <strong className="mr-2 rounded bg-white/80 px-1.5 py-0.5 font-bold uppercase tracking-widest">
        {mode}
      </strong>
      <span className={cn("font-medium", mode === "TEST" && "rounded bg-white/80 px-1.5 py-0.5")}>
        {children ?? defaultText[mode]}
      </span>
    </div>
  );
}

export interface PreviewBannerProps {
  /** Optional detail after the fixed text, for example the protocol version being previewed. */
  children?: ReactNode;
  className?: string;
}

/** Shown above the participant flow when a researcher previews it from Study Flow (spec 130). */
export function PreviewBanner({ children, className }: PreviewBannerProps) {
  return (
    <div
      role="region"
      aria-label="Preview"
      className={cn(
        "sticky top-0 z-20 w-full border-b-2 border-slate-900 bg-slate-900 px-4 py-2 text-center text-sm text-white",
        className,
      )}
    >
      <strong className="font-bold uppercase tracking-widest">PREVIEW - NOT RESEARCH DATA</strong>
      {children && <span className="ml-3 text-slate-300">{children}</span>}
    </div>
  );
}
