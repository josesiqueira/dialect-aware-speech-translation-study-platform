import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export interface StepActionsProps {
  /** The way forward: <Button size="lg">Continue</Button>. */
  primary: ReactNode;
  /** The way back or the alternative: <Button size="lg" variant="secondary">Back</Button>. */
  secondary?: ReactNode;
  /** row: secondary left, primary right (stacked on small screens). stack: full-width column, primary first. */
  layout?: "row" | "stack";
  className?: string;
}

/**
 * Button row at the end of a participant step. On a phone the buttons stack
 * and the primary action comes first.
 */
export function StepActions({ primary, secondary, layout = "row", className }: StepActionsProps) {
  if (layout === "stack") {
    return (
      <div className={cn("mt-6 flex flex-col gap-3 *:w-full", className)}>
        {primary}
        {secondary}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "mt-6 flex flex-col gap-3 *:w-full sm:flex-row-reverse sm:items-center sm:*:w-auto",
        secondary ? "sm:justify-between" : "sm:justify-start",
        className,
      )}
    >
      {primary}
      {secondary}
    </div>
  );
}
