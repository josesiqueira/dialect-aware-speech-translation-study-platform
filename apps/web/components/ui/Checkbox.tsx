"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  /** Muted second line under the label. */
  description?: ReactNode;
  /** Field-specific error, linked with aria-describedby. */
  error?: ReactNode;
  /** participant: text-base label for consent items. */
  density?: "admin" | "participant";
}

/** Native checkbox with a visible label and optional description. */
export function Checkbox({
  label,
  description,
  error,
  density = "admin",
  className,
  id,
  ...rest
}: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className={className}>
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          id={inputId}
          aria-describedby={[descriptionId, errorId].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : undefined}
          className={cn(
            "shrink-0 rounded border-slate-300 accent-slate-900",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1",
            density === "participant" ? "mt-1 h-5 w-5" : "mt-0.5 h-4 w-4",
          )}
          {...rest}
        />
        <div className="min-w-0">
          <label
            htmlFor={inputId}
            className={cn(
              "cursor-pointer text-slate-700",
              density === "participant" ? "text-base" : "text-sm font-medium",
            )}
          >
            {label}
          </label>
          {description && (
            <p id={descriptionId} className="text-xs text-slate-500">
              {description}
            </p>
          )}
        </div>
      </div>
      {error && (
        <p id={errorId} className="mt-1 text-sm text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
