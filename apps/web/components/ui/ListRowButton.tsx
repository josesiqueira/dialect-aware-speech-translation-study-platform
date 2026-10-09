import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export interface ListRowButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Marks the row whose detail is shown in the detail panel. */
  selected?: boolean;
}

/**
 * One compact row of a list and detail browser (the reference ConversationList
 * row): full width, py-2, slate-50 hover, a clear selected state. Wrap the
 * rows in <div className="divide-y divide-slate-100">.
 *
 * Muted metadata (text-slate-500) inside the selected row is rendered as
 * slate-600: slate-500 on the blue-50 selected background is 4.38:1, below
 * the 4.5:1 minimum (design-system/ACCESSIBILITY.md).
 */
export function ListRowButton({ selected = false, className, type = "button", ...rest }: ListRowButtonProps) {
  return (
    <button
      type={type}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "block w-full border-l-2 px-3 py-2 text-left transition-colors hover:bg-slate-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600",
        selected ? "border-blue-500 bg-blue-50 hover:bg-blue-50" : "border-transparent",
        "aria-[current=true]:[&_.text-slate-500]:text-slate-600",
        className,
      )}
      {...rest}
    />
  );
}
