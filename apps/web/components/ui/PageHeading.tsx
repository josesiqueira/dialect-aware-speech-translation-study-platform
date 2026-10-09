import type { ReactNode } from "react";
import { cn } from "./cn";

export interface PageHeadingProps {
  title: ReactNode;
  /** One concise muted description. */
  description?: ReactNode;
  /** Right side controls, for example a RefreshButton. */
  actions?: ReactNode;
  className?: string;
}

/** Start of every admin page: title, one muted description, optional actions. One per page. */
export function PageHeading({ title, description, actions, className }: PageHeadingProps) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </header>
  );
}
