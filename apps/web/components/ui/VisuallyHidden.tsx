import type { HTMLAttributes } from "react";
import { cn } from "./cn";

/** Text for screen readers only. */
export function VisuallyHidden({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("sr-only", className)} {...rest} />;
}
