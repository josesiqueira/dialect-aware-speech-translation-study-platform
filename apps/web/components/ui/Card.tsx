import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type CardVariant = "admin" | "participant";
export type CardPadding = "none" | "sm" | "md" | "lg";

const variantClasses: Record<CardVariant, string> = {
  admin: "rounded-lg",
  participant: "rounded-xl",
};

const paddingClasses: Record<CardPadding, string> = {
  none: "",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
};

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** admin: rounded-lg. participant: rounded-xl. Both: white, slate-200 border, shadow-sm. */
  variant?: CardVariant;
  /** none (use CardHeader and CardBody), sm p-4, md p-6 (default), lg p-8. */
  padding?: CardPadding;
  as?: "div" | "section" | "article";
}

/** White bordered surface. The only surface treatment in the system. */
export function Card({
  variant = "admin",
  padding = "md",
  as: Tag = "div",
  className,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={cn(
        "border border-slate-200 bg-white shadow-sm",
        variantClasses[variant],
        paddingClasses[padding],
        padding === "none" && "overflow-hidden",
        className,
      )}
      {...rest}
    />
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** One short muted line under the title. */
  description?: ReactNode;
  /** Status and version metadata shown next to the title (badges, dates). */
  meta?: ReactNode;
  /** Right side: Edit, Cancel, Save. */
  actions?: ReactNode;
  headingLevel?: "h2" | "h3";
  className?: string;
}

/**
 * Header row of an editor or settings card, as in the reference Prompts and
 * Data pages. Use inside <Card padding="none">.
 */
export function CardHeader({
  title,
  description,
  meta,
  actions,
  headingLevel: Heading = "h2",
  className,
}: CardHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <Heading className="text-base font-semibold text-slate-900">{title}</Heading>
          {meta}
        </div>
        {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Body of a card that has a CardHeader. */
export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 py-5", className)} {...rest} />;
}
