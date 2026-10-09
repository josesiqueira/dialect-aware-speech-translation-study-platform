// Text and field differences for the "Compare versions" view (spec 142).
import { diffLines, diffWordsWithSpace, type Change } from "diff";

export type DiffPart = { type: "added" | "removed" | "unchanged"; value: string };

export type FieldChange = { field: string; before: string | null; after: string | null; changed: boolean };

function toParts(changes: Change[]): DiffPart[] {
  return changes.map((change) => ({
    type: change.added ? "added" : change.removed ? "removed" : "unchanged",
    value: change.value,
  }));
}

// Line level difference from `before` to `after`.
export function diffTextLines(before: string, after: string): DiffPart[] {
  return toParts(diffLines(before, after));
}

// Word level difference from `before` to `after`. Whitespace is kept, so the
// parts joined together give back the two texts exactly.
export function diffTextWords(before: string, after: string): DiffPart[] {
  return toParts(diffWordsWithSpace(before, after));
}

export function fieldChange(field: string, before: string | null, after: string | null): FieldChange {
  return { field, before, after, changed: before !== after };
}

// JSON with object keys sorted at every level, so that two parameter records
// with the same content print the same text whatever the key order.
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}
