import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { Spinner } from "./Spinner";
import { focusRing } from "./styles";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  // Dark slate primary action, as every Save, Sign In and Start button in the reference.
  primary: "bg-slate-900 text-white hover:bg-slate-800 active:bg-slate-950",
  secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 active:bg-slate-100",
  // Reserved for destructive actions and for stopping an active recording.
  danger: "bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "rounded-md px-3 py-1.5 text-sm font-medium", // header rows: Edit, Cancel, Save
  md: "rounded-md px-4 py-2 text-sm font-medium", // admin default (reference SaveButton)
  lg: "rounded-xl px-6 py-3 text-base font-semibold", // participant actions
};

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}

/** Class string shared by Button and LinkButton. */
export function buttonClasses({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
}: ButtonStyleOptions = {}): string {
  return cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors",
    "disabled:cursor-not-allowed disabled:opacity-50",
    focusRing,
    variantClasses[variant],
    sizeClasses[size],
    fullWidth && "w-full",
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleOptions {
  /** Shows the compact spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  /** Label shown while loading, for example "Saving...". Defaults to the children. */
  loadingLabel?: ReactNode;
}

/**
 * Button: a real <button>. The default type is "button" so that a button
 * inside a form never submits by accident; pass type="submit" explicitly.
 */
export function Button({
  variant,
  size,
  fullWidth,
  className,
  loading = false,
  loadingLabel,
  disabled,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, fullWidth, className })}
      {...rest}
    >
      {loading && <Spinner />}
      {loading && loadingLabel !== undefined ? loadingLabel : children}
    </button>
  );
}
