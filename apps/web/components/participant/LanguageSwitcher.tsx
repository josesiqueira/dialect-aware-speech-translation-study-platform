"use client";

import { cn } from "@/components/ui/cn";
import { focusRing } from "@/components/ui/styles";

export interface LanguageOption {
  /** BCP 47 code, for example "fi" or "en". */
  code: string;
  /** Name of the language in that language: "Suomi", "English". */
  label: string;
}

export interface LanguageSwitcherProps {
  languages: LanguageOption[];
  current: string;
  onChange: (code: string) => void;
  /** Accessible name of the group, in the current interface language. */
  groupLabel?: string;
}

/**
 * Compact language buttons, as at the top of the reference landing page. The
 * visible pill keeps its compact size; the button around it is 44 px tall, so
 * the pressable area is large enough on a phone.
 */
export function LanguageSwitcher({
  languages,
  current,
  onChange,
  groupLabel = "Language",
}: LanguageSwitcherProps) {
  return (
    <div role="group" aria-label={groupLabel} className="flex gap-1">
      {languages.map((language) => {
        const active = language.code === current;
        return (
          <button
            key={language.code}
            type="button"
            lang={language.code}
            aria-pressed={active}
            onClick={() => onChange(language.code)}
            className={cn("group inline-flex min-h-11 items-center rounded-md", focusRing)}
          >
            <span
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                active
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-600 group-hover:bg-slate-100",
              )}
            >
              {language.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
