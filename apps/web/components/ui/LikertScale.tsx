"use client";

import { useId, type ReactNode } from "react";
import { cn } from "./cn";
import { segmentLabelClasses } from "./RadioGroup";
import { labelBase } from "./styles";

export interface LikertScaleProps {
  /** The question. Rendered as the fieldset legend. */
  label: ReactNode;
  value: number | null;
  onChange: (value: number) => void;
  /** Lowest point of the scale. Default 1. */
  min?: number;
  /** Highest point of the scale. Default 5. */
  max?: number;
  /** Anchor text under the lowest point, for example "Not at all". */
  lowLabel?: ReactNode;
  /** Anchor text under the highest point, for example "Completely". */
  highLabel?: ReactNode;
  name?: string;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Equal-width 1 to N buttons, as on the reference Survey page: selected state
 * slate-900 with white text, neutral unselected state.
 *
 * Each button is a label around a native radio input, so the scale is a real
 * radio group: Tab enters the group, the arrow keys move and select, and
 * screen readers announce "radio, 3 of 5".
 */
export function LikertScale({
  label,
  value,
  onChange,
  min = 1,
  max = 5,
  lowLabel,
  highLabel,
  name,
  help,
  error,
  required = false,
  disabled = false,
  className,
}: LikertScaleProps) {
  const generatedId = useId();
  const groupName = name ?? generatedId;
  const helpId = help ? `${generatedId}-help` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const anchorsId = lowLabel || highLabel ? `${generatedId}-anchors` : undefined;
  const describedBy = [helpId, anchorsId, errorId].filter(Boolean).join(" ") || undefined;

  const points: number[] = [];
  for (let n = min; n <= max; n += 1) points.push(n);

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
      <div className="mb-1 flex gap-2">
        {points.map((n) => (
          <label key={n} className={cn(segmentLabelClasses, "py-2.5 font-medium tabular-nums")}>
            <input
              type="radio"
              className="sr-only"
              name={groupName}
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              required={required}
            />
            {n}
          </label>
        ))}
      </div>
      {anchorsId && (
        <div id={anchorsId} className="flex justify-between px-1 text-xs text-slate-500">
          <span>
            <span className="sr-only">{min} means </span>
            {lowLabel}
          </span>
          <span>
            <span className="sr-only">{max} means </span>
            {highLabel}
          </span>
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
