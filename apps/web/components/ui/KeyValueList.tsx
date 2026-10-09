import type { ReactNode } from "react";
import { cn } from "./cn";

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Monospace tabular value: identifiers, hashes, model names, durations. */
  mono?: boolean;
}

export interface KeyValueListProps {
  items: KeyValueItem[];
  /** 1: stacked rows with a fixed label column. 2: two-column grid as in the reference detail header. */
  columns?: 1 | 2;
  className?: string;
}

/** Metadata as a description list. */
export function KeyValueList({ items, columns = 2, className }: KeyValueListProps) {
  return (
    <dl
      className={cn(
        "text-sm text-slate-600",
        columns === 2 ? "grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2" : "space-y-2",
        className,
      )}
    >
      {items.map((item, index) => (
        <div key={index} className={cn("min-w-0", columns === 1 && "grid grid-cols-[10rem_1fr] gap-3")}>
          <dt className={cn("font-medium text-slate-700", columns === 2 && "inline")}>
            {item.label}
            {columns === 2 && ": "}
          </dt>
          <dd
            className={cn(
              "min-w-0 break-words",
              columns === 2 && "inline",
              item.mono && "font-mono text-xs tabular-nums text-slate-700",
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
