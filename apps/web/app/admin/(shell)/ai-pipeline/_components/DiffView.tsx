import { cn, focusRing, scrollRegionProps } from "@/components/ui";
import type { ConfigDiff, DiffPart, FieldChange, PromptDiff } from "./types";

const FIELD_LABELS: Record<string, string> = {
  key: "Key",
  stage: "Stage",
  conditionKey: "Condition key",
  name: "Name",
  notes: "Notes",
  provider: "Provider",
  modelId: "Model",
  promptVersion: "Prompt version",
};

// Fields shown as a line difference instead of a table row.
const TEXT_FIELDS = new Set(["promptText", "parameters"]);

type Line = { type: DiffPart["type"]; text: string };

function toLines(parts: DiffPart[]): Line[] {
  const lines: Line[] = [];
  for (const part of parts) {
    const pieces = part.value.split("\n");
    // A part that ends with a line break gives one empty piece too many.
    if (pieces.length > 1 && pieces[pieces.length - 1] === "") pieces.pop();
    for (const text of pieces) lines.push({ type: part.type, text });
  }
  return lines;
}

const MARKERS: Record<DiffPart["type"], string> = { added: "+", removed: "-", unchanged: " " };
const SPOKEN: Record<DiffPart["type"], string> = { added: "Added: ", removed: "Removed: ", unchanged: "" };

/** Line difference in monospace. A plus or minus sign marks each changed line, so color is not the only cue. */
export function DiffLines({ parts, label }: { parts: DiffPart[]; label: string }) {
  const lines = toLines(parts);
  if (lines.length === 0) {
    return <p className="text-xs text-slate-500">{label}: both versions are empty.</p>;
  }
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-slate-700">{label}</p>
      <div
        {...scrollRegionProps(label)}
        className={cn(
          "relative max-h-64 overflow-auto rounded-lg border border-slate-200 bg-slate-50 py-2 font-mono text-xs leading-relaxed",
          focusRing,
        )}
      >
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              "flex gap-2 px-3 whitespace-pre-wrap",
              line.type === "added" && "bg-emerald-50 text-emerald-800",
              line.type === "removed" && "bg-rose-50 text-rose-700",
              line.type === "unchanged" && "text-slate-600",
            )}
          >
            <span aria-hidden="true" className="select-none">
              {MARKERS[line.type]}
            </span>
            <span className="min-w-0 break-words">
              <span className="sr-only">{SPOKEN[line.type]}</span>
              {line.text === "" ? " " : line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FieldChanges({ fields }: { fields: FieldChange[] }) {
  const changed = fields.filter((field) => field.changed && !TEXT_FIELDS.has(field.field));
  if (changed.length === 0) return null;
  return (
    <table className="w-full border-collapse text-left text-xs">
      <thead>
        <tr className="text-slate-500">
          <th scope="col" className="py-1 pr-3 font-medium">
            Field
          </th>
          <th scope="col" className="py-1 pr-3 font-medium">
            Before
          </th>
          <th scope="col" className="py-1 font-medium">
            After
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {changed.map((field) => (
          <tr key={field.field}>
            <th scope="row" className="py-1 pr-3 align-top font-medium text-slate-700">
              {FIELD_LABELS[field.field] ?? field.field}
            </th>
            <td className="py-1 pr-3 align-top font-mono break-words text-rose-700">{field.before ?? "(not set)"}</td>
            <td className="py-1 align-top font-mono break-words text-emerald-800">{field.after ?? "(not set)"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function isConfigDiff(diff: PromptDiff | ConfigDiff): diff is ConfigDiff {
  return "parameterLines" in diff;
}

/** The difference from version A to version B (spec 142). */
export function DiffView({ diff }: { diff: PromptDiff | ConfigDiff }) {
  const heading = `${diff.a.key} v${diff.a.versionNumber} (${diff.a.status}) compared with ${diff.b.key} v${diff.b.versionNumber} (${diff.b.status})`;
  return (
    <div className="space-y-3" data-testid="diff-view">
      <p className="text-xs text-slate-500 tabular-nums">{heading}</p>
      {diff.identical ? (
        <p className="text-sm text-slate-600">The two versions are identical.</p>
      ) : (
        <>
          <FieldChanges fields={diff.fields} />
          {isConfigDiff(diff) ? (
            <>
              {diff.fields.some((field) => field.field === "parameters" && field.changed) && (
                <DiffLines parts={diff.parameterLines} label="Parameters" />
              )}
              {diff.promptText && <DiffLines parts={diff.promptText.lines} label="Text of the linked prompt" />}
            </>
          ) : (
            diff.fields.some((field) => field.field === "promptText" && field.changed) && (
              <DiffLines parts={diff.lines} label="Prompt text" />
            )
          )}
        </>
      )}
    </div>
  );
}
