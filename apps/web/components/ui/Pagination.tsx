import { cn } from "./cn";
import { focusRing } from "./styles";

export interface PaginationProps {
  /** Current page, starting at 1. */
  page: number;
  pageSize: number;
  /** Total number of items over all pages. */
  total: number;
  onPageChange: (page: number) => void;
  /** Plural noun for the count, for example "sessions". */
  itemLabel?: string;
  disabled?: boolean;
  className?: string;
}

const pageButton =
  "rounded border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-50 transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-40";

/** Previous and Next with the total count, as under the reference conversation list. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  itemLabel = "items",
  disabled = false,
  className,
}: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2 text-sm text-slate-500",
        className,
      )}
    >
      <span className="tabular-nums">
        {total} {itemLabel}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={disabled || page <= 1}
          className={cn(pageButton, focusRing)}
        >
          Previous
        </button>
        <span className="px-1 tabular-nums" aria-current="page">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          disabled={disabled || page >= pageCount}
          className={cn(pageButton, focusRing)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
