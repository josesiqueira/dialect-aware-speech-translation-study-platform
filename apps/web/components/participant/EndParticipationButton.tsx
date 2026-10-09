import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/components/ui/cn";
import { focusRing } from "@/components/ui/styles";

/**
 * Discreet text action for withdrawing from the study. Always available,
 * never prominent, never styled as danger: ending participation is the
 * participant's right, not an error.
 *
 * The text keeps its small size; vertical padding makes the pressable area
 * 44 px tall.
 */
export function EndParticipationButton({
  className,
  children = "End participation",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        "rounded py-3 text-sm text-slate-500 underline underline-offset-2 hover:text-slate-800",
        focusRing,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
