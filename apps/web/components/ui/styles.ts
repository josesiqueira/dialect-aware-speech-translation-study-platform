/**
 * Shared class strings. These are the class conventions of the design system
 * (design-system/COMPONENTS.md). Components import them so that focus rings,
 * inputs and labels cannot drift apart.
 */

/** Keyboard focus ring for links, buttons and other clickable elements. */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1";

/**
 * Attributes for a scrolling block that has no focusable content (a read-only
 * prompt, a long table): a keyboard user can focus it and scroll with the arrow
 * keys (WCAG 2.1.1). Add `focusRing` to its classes.
 */
export function scrollRegionProps(label: string) {
  return { tabIndex: 0, role: "region", "aria-label": label } as const;
}

/** Text inputs, text areas and selects in forms. */
export const inputBase =
  "block w-full border border-slate-300 bg-white text-slate-900 placeholder:text-slate-500 " +
  "transition-colors focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600 " +
  "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60 " +
  "aria-[invalid=true]:border-rose-500";

/** Admin density (default) and participant density. */
export const inputSizes = {
  md: "rounded-md px-3 py-2 text-sm",
  lg: "rounded-lg px-3 py-2 text-base",
} as const;

export type InputSize = keyof typeof inputSizes;

/** Visible form label. */
export const labelBase = "block text-sm font-medium text-slate-700";

/** Small uppercase muted label (metric labels, export field labels, table headers). */
export const overlineLabel = "text-xs font-medium uppercase tracking-wide text-slate-500";

/** Compact filter control (FilterBar). */
export const filterControl =
  "rounded-lg border border-slate-300 bg-white py-1.5 text-sm text-slate-700 " +
  "placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600";

/**
 * A scrolling container must be a positioned element ("relative") when it has
 * visually hidden children such as a table caption: "sr-only" is absolutely
 * positioned, and without a positioned scrolling ancestor the hidden element
 * is laid out against the page and makes the document taller than its content.
 *
 * Table conventions for compact rows with a sticky header. Use with DataTable,
 * or apply directly when a page needs a hand-written table.
 */
export const tableClasses = {
  wrapper: "relative overflow-auto rounded-lg border border-slate-200 bg-white",
  table: "w-full border-collapse text-left text-sm",
  thead: "sticky top-0 z-10 bg-slate-50",
  th: "border-b border-slate-200 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap",
  tbody: "divide-y divide-slate-100",
  tr: "hover:bg-slate-50 transition-colors",
  /** Muted metadata on the selected (blue-50) row is slate-600: slate-500 there is 4.38:1. */
  trSelected: "bg-blue-50 [&_.text-slate-500]:text-slate-600",
  td: "px-3 py-2 align-top text-slate-700",
  tdNumeric: "px-3 py-2 align-top text-right tabular-nums text-slate-700",
} as const;
