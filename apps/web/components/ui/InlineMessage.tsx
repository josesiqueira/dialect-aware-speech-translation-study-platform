import type { ReactNode } from "react";
import { cn } from "./cn";

export type MessageVariant = "success" | "error" | "info" | "warning";

const variantClasses: Record<MessageVariant, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-rose-200 bg-rose-50 text-rose-700",
  info: "border-blue-200 bg-blue-50 text-blue-900",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
};

const prefixes: Record<MessageVariant, string> = {
  success: "Success: ",
  error: "Error: ",
  info: "Information: ",
  warning: "Warning: ",
};

export interface InlineMessageProps {
  variant?: MessageVariant;
  /** Optional bold first line. */
  title?: ReactNode;
  children: ReactNode;
  /**
   * How the message is announced. Default: "alert" for error, "status" for the
   * others. Pass "none" for static guidance that is present when the page loads.
   */
  announce?: "alert" | "status" | "none";
  /** Id of the message, so that a control can point at it with aria-describedby. */
  id?: string;
  className?: string;
}

/**
 * Message shown in place, next to what it is about. This replaces routine
 * toasts. A screen-reader-only prefix names the kind of message, so the
 * meaning does not depend on color.
 */
export function InlineMessage({
  variant = "info",
  title,
  children,
  announce,
  id,
  className,
}: InlineMessageProps) {
  const mode = announce ?? (variant === "error" ? "alert" : "status");
  return (
    <div
      id={id}
      role={mode === "none" ? undefined : mode}
      className={cn("rounded-lg border px-4 py-2 text-sm", variantClasses[variant], className)}
    >
      <span className="sr-only">{prefixes[variant]}</span>
      {title && <p className="mb-0.5 font-medium">{title}</p>}
      {children}
    </div>
  );
}

export interface InlineStatusProps {
  variant: "success" | "error" | "pending";
  children: ReactNode;
  className?: string;
}

/** One short status next to a control: "Saved", "Saving...", "Save failed". */
export function InlineStatus({ variant, children, className }: InlineStatusProps) {
  return (
    <span
      role={variant === "error" ? "alert" : "status"}
      className={cn(
        "text-sm",
        variant === "success" && "text-emerald-700",
        variant === "error" && "text-rose-700",
        variant === "pending" && "text-slate-500",
        className,
      )}
    >
      {children}
    </span>
  );
}
