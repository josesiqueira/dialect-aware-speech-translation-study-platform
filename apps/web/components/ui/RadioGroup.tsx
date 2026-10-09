"use client";

import { useId, type ReactNode } from "react";
import { cn } from "./cn";
import { labelBase } from "./styles";

export interface RadioOption {
  value: string;
  label: ReactNode;
  /** Muted second line (list layout only). */
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  /** Rendered as the fieldset legend. */
  label: ReactNode;
  options: RadioOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** Radio group name. Generated when omitted. */
  name?: string;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  /**
   * list: native radios with labels, stacked (or in a row with orientation="horizontal").
   * buttons: equal-width buttons, selected state slate-900 with white text
   * (the reference Survey "yes / no / unsure" row).
   */
  layout?: "list" | "buttons";
  orientation?: "vertical" | "horizontal";
  className?: string;
}

/** Shared by RadioGroup (buttons layout) and LikertScale. A real radio input inside each label. */
export const segmentLabelClasses =
  "flex-1 cursor-pointer rounded-lg border border-slate-300 bg-white text-center text-slate-600 transition-colors " +
  "hover:bg-slate-50 " +
  "has-checked:border-slate-900 has-checked:bg-slate-900 has-checked:text-white " +
  "has-focus-visible:ring-2 has-focus-visible:ring-blue-600 has-focus-visible:ring-offset-1 " +
  "has-disabled:cursor-not-allowed has-disabled:opacity-50";

/**
 * Single choice from a short list. Native radio inputs in a fieldset: arrow
 * keys move the selection and Tab enters and leaves the group, as the platform does.
 */
export function RadioGroup({
  label,
  options,
  value,
  onChange,
  name,
  help,
  error,
  required = false,
  disabled = false,
  layout = "list",
  orientation = "vertical",
  className,
}: RadioGroupProps) {
  const generatedId = useId();
  const groupName = name ?? generatedId;
  const helpId = help ? `${generatedId}-help` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <fieldset
      className={cn("min-w-0", className)}
      aria-describedby={describedBy}
      disabled={disabled}
    >
      <legend className={cn(labelBase, "mb-2")}>
        {label}
        {required && <span className="font-normal text-slate-500"> (required)</span>}
      </legend>
      {help && (
        <p id={helpId} className="-mt-1 mb-2 text-xs text-slate-500">
          {help}
        </p>
      )}

      {layout === "buttons" ? (
        <div className="flex gap-3">
          {options.map((o) => (
            <label key={o.value} className={cn(segmentLabelClasses, "px-2 py-2 text-sm")}>
              <input
                type="radio"
                className="sr-only"
                name={groupName}
                value={o.value}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
                disabled={o.disabled}
                required={required}
              />
              {o.label}
            </label>
          ))}
        </div>
      ) : (
        <div
          className={cn(
            orientation === "horizontal" ? "flex flex-wrap gap-x-4 gap-y-2" : "space-y-2",
          )}
        >
          {options.map((o) => {
            const optionId = `${generatedId}-${o.value}`;
            return (
              <div key={o.value} className="flex items-start gap-2">
                <input
                  type="radio"
                  id={optionId}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1"
                  name={groupName}
                  value={o.value}
                  checked={value === o.value}
                  onChange={() => onChange(o.value)}
                  disabled={o.disabled}
                  required={required}
                  aria-describedby={o.description ? `${optionId}-description` : undefined}
                />
                <div className="min-w-0">
                  <label htmlFor={optionId} className="cursor-pointer text-sm text-slate-700">
                    {o.label}
                  </label>
                  {o.description && (
                    <p id={`${optionId}-description`} className="text-xs text-slate-500">
                      {o.description}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p id={errorId} className="mt-1 text-sm text-rose-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}
