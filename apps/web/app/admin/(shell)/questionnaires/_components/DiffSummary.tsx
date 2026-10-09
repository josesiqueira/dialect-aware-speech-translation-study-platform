// The difference between two questionnaire versions as a short list (spec 76).
import { questionnaireSchemas as s } from "@dialect/domain";
import { cn, focusRing } from "@/components/ui";

export function DiffSummary({ diff }: { diff: s.QuestionnaireDiff }) {
  if (diff.from === null) {
    return (
      <p>
        This is the first version of <span className="font-mono">{diff.to.key}</span>: there is no earlier published
        version to compare with. It has {diff.added.length} {diff.added.length === 1 ? "item" : "items"}.
      </p>
    );
  }
  const against = `version ${diff.from.versionNumber}`;
  if (diff.identical) return <p>No differences from {against}.</p>;
  return (
    <div className="space-y-2">
      <p>
        Compared with {against} ({diff.from.status}):
      </p>
      {/* Focusable so that a long list can be scrolled with the keyboard. It stays a list: no region role. */}
      <ul
        tabIndex={0}
        aria-label={`Differences from ${against}`}
        className={cn(
          "max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700",
          focusRing,
        )}
      >
        {diff.nameChanged && <li>The name changed.</li>}
        {diff.descriptionChanged && <li>The description changed.</li>}
        {diff.added.map((item) => (
          <li key={`added-${item.itemKey}`}>
            <span className="font-medium text-emerald-700">Added</span> <span className="font-mono">{item.itemKey}</span>
            : {item.prompt}
          </li>
        ))}
        {diff.removed.map((item) => (
          <li key={`removed-${item.itemKey}`}>
            <span className="font-medium text-rose-700">Removed</span> <span className="font-mono">{item.itemKey}</span>
            : {item.prompt}
          </li>
        ))}
        {diff.changed.map((entry) => (
          <li key={`changed-${entry.itemKey}`}>
            <span className="font-medium text-amber-800">Changed</span> <span className="font-mono">{entry.itemKey}</span>
            : {entry.changes.map((change) => s.ITEM_CHANGE_LABELS[change]).join(", ")}
            {entry.changes.includes("wording") && (
              <span className="mt-0.5 block text-xs text-slate-500">
                Before: {entry.before.prompt}
                <br />
                After: {entry.after.prompt}
              </span>
            )}
            {entry.changes.includes("scale") && (
              <span className="mt-0.5 block text-xs text-slate-500">
                Scale before: {describeScale(entry.before.config)}. After: {describeScale(entry.after.config)}.
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">
        {diff.unchangedCount} {diff.unchangedCount === 1 ? "item is" : "items are"} unchanged.
      </p>
    </div>
  );
}

function describeScale(config: s.QuestionnaireItemConfig): string {
  if (config.scaleMin === undefined && config.scaleMax === undefined) return "none";
  const labels = [config.scaleMinLabel, config.scaleMaxLabel].filter(Boolean).join(" / ");
  return `${config.scaleMin ?? "?"} to ${config.scaleMax ?? "?"}${labels ? ` (${labels})` : ""}`;
}
