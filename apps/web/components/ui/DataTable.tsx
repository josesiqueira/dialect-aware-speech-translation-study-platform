import type { ReactNode } from "react";
import { cn } from "./cn";
import { EmptyState } from "./States";
import { focusRing, scrollRegionProps, tableClasses } from "./styles";

export interface DataTableColumn<Row> {
  /** Unique column key. */
  key: string;
  header: ReactNode;
  /** Cell content for a row. */
  cell: (row: Row) => ReactNode;
  /** right: numbers, durations and counts (adds tabular-nums). */
  align?: "left" | "right";
  /** Extra classes for the cells of this column, for example "w-40" or "font-mono text-xs". */
  className?: string;
  /** Render the cell as a row header (<th scope="row">). Use for the identifying column. */
  rowHeader?: boolean;
}

export interface DataTableProps<Row> {
  /** Accessible name of the table. Rendered as a visually hidden caption. */
  caption: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row) => string;
  /** Key of the row to mark as selected. */
  selectedKey?: string | null;
  /** Shown instead of the body when rows is empty. */
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  /** Constrain the height and scroll inside, keeping the header visible, for example "max-h-[70vh]". */
  maxHeightClassName?: string;
  /**
   * Make the scrolling wrapper a focusable region named by the caption, so it can be scrolled with
   * the keyboard. Default: true when maxHeightClassName is set. Pass false when every row has a
   * button or link, because focus on those already scrolls the table.
   */
  scrollRegion?: boolean;
  className?: string;
}

/**
 * Compact data table: sticky small uppercase header, py-2 rows, subtle
 * dividers, slate-50 hover. Put links or buttons inside cells for row actions;
 * the row itself is not clickable, which keeps the table semantics intact.
 */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  selectedKey,
  emptyTitle = "No rows.",
  emptyDescription,
  maxHeightClassName,
  scrollRegion = Boolean(maxHeightClassName),
  className,
}: DataTableProps<Row>) {
  return (
    <div
      className={cn(tableClasses.wrapper, maxHeightClassName, scrollRegion && focusRing, className)}
      {...(scrollRegion ? scrollRegionProps(caption) : {})}
    >
      <table className={tableClasses.table}>
        <caption className="sr-only">{caption}</caption>
        <thead className={tableClasses.thead}>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(tableClasses.th, column.align === "right" && "text-right")}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        {rows.length > 0 && (
          <tbody className={tableClasses.tbody}>
            {rows.map((row) => {
              const key = getRowKey(row);
              const selected = selectedKey === key;
              return (
                <tr
                  key={key}
                  className={cn(tableClasses.tr, selected && tableClasses.trSelected)}
                  aria-selected={selectedKey === undefined ? undefined : selected}
                >
                  {columns.map((column) => {
                    const cellClass = cn(
                      column.align === "right" ? tableClasses.tdNumeric : tableClasses.td,
                      column.className,
                    );
                    return column.rowHeader ? (
                      <th key={column.key} scope="row" className={cn(cellClass, "text-left font-medium")}>
                        {column.cell(row)}
                      </th>
                    ) : (
                      <td key={column.key} className={cellClass}>
                        {column.cell(row)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        )}
      </table>
      {rows.length === 0 && <EmptyState title={emptyTitle} description={emptyDescription} />}
    </div>
  );
}
