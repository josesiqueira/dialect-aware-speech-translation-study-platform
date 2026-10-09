import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export interface ParticipantHeadingProps {
  title: ReactNode;
  /** One muted line under the title. */
  description?: ReactNode;
  /** Small line above the title, for example the task type: "Controlled speaking task". */
  eyebrow?: ReactNode;
  /** lg: text-3xl, the welcome page. md: text-2xl, every other step. */
  size?: "md" | "lg";
  align?: "center" | "left";
  /** Receives focus when a new step is shown, so screen readers start at the heading. */
  id?: string;
  /** `lang` of the title, for a title that is study content in a declared language. */
  titleLang?: string;
  className?: string;
}

/** The single h1 of a participant step. */
export function ParticipantHeading({
  title,
  description,
  eyebrow,
  size = "md",
  align = "center",
  id,
  titleLang,
  className,
}: ParticipantHeadingProps) {
  return (
    <div className={cn("mb-6", align === "center" && "text-center", className)}>
      {eyebrow && <p className="mb-1 text-sm font-medium text-slate-500">{eyebrow}</p>}
      <h1
        id={id}
        lang={titleLang}
        tabIndex={-1}
        className={cn("font-bold text-slate-900 focus:outline-none", size === "lg" ? "text-3xl" : "text-2xl")}
      >
        {title}
      </h1>
      {description && <p className="mt-2 text-slate-500">{description}</p>}
    </div>
  );
}
