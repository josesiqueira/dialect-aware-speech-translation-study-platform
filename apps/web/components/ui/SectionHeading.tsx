import type { ReactNode } from "react";
import { cn } from "./cn";

export interface SectionHeadingProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right side: a small count or a compact control. */
  aside?: ReactNode;
  /** base: heading inside a card. lg: page section outside a card (reference Settings). */
  size?: "base" | "lg";
  as?: "h2" | "h3";
  id?: string;
  className?: string;
}

/** Section heading inside a page or a card. */
export function SectionHeading({
  title,
  description,
  aside,
  size = "base",
  as: Heading = "h2",
  id,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn("mb-4", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Heading
          id={id}
          className={cn("font-semibold text-slate-900", size === "lg" ? "text-lg" : "text-base")}
        >
          {title}
        </Heading>
        {aside && <div className="text-xs text-slate-500 tabular-nums">{aside}</div>}
      </div>
      {description && (
        <p className={cn("mt-0.5 text-slate-500", size === "lg" ? "text-sm" : "text-xs")}>
          {description}
        </p>
      )}
    </div>
  );
}
