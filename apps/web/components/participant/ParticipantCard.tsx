import type { HTMLAttributes } from "react";
import { cn } from "@/components/ui/cn";

export interface ParticipantCardProps extends HTMLAttributes<HTMLElement> {
  /** md: p-6 (sections, prompts). lg: p-8 (centered transition and completion cards). */
  padding?: "md" | "lg";
  as?: "div" | "section";
}

/**
 * The participant surface: white, rounded-xl, slate-200 border, shadow-sm.
 * Use one per meaningful section (study information, consent, microphone
 * check, task prompt, questionnaire section, completion). Do not wrap every
 * paragraph in a card.
 */
export function ParticipantCard({ padding = "md", as: Tag = "div", className, ...rest }: ParticipantCardProps) {
  return (
    <Tag
      className={cn(
        "rounded-xl border border-slate-200 bg-white shadow-sm",
        padding === "lg" ? "p-8" : "p-6",
        className,
      )}
      {...rest}
    />
  );
}
