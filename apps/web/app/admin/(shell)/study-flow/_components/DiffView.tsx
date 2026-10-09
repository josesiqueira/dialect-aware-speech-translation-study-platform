import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import { ORDER_MODE_LABELS, type ProtocolDiff, type TextChange } from "./types";

type TaskDiff = ProtocolDiff["tasksChanged"][number];
type ValueChange = TaskDiff["valueChanges"][number];
type SelectionRef = ProtocolDiff["questionnaireChanges"][number]["before"];

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-900">
        {title}
        {count !== undefined && <span className="ml-2 font-normal text-slate-500 tabular-nums">{count}</span>}
      </h4>
      {children}
    </section>
  );
}

/**
 * Old and new text as two lines, "-" and "+", with the changed words marked
 * (spec 141). The signs and the words "Before" and "After" carry the meaning,
 * the tint only supports it.
 */
export function TextDiff({ change }: { change: TextChange }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="text-xs font-medium text-slate-500">{change.label}</p>
      <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 whitespace-pre-wrap text-slate-800">
        <span className="mr-2 font-mono font-semibold text-rose-700" aria-hidden="true">
          -
        </span>
        <span className="sr-only">Before: </span>
        {change.before === "" ? (
          <span className="text-slate-500">(empty)</span>
        ) : (
          change.parts
            .filter((part) => !part.added)
            .map((part, index) =>
              part.removed ? (
                <del key={index} className="bg-rose-200 text-rose-900 decoration-rose-700">
                  {part.value}
                </del>
              ) : (
                <span key={index}>{part.value}</span>
              ),
            )
        )}
      </div>
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 whitespace-pre-wrap text-slate-800">
        <span className="mr-2 font-mono font-semibold text-emerald-700" aria-hidden="true">
          +
        </span>
        <span className="sr-only">After: </span>
        {change.after === "" ? (
          <span className="text-slate-500">(empty)</span>
        ) : (
          change.parts
            .filter((part) => !part.removed)
            .map((part, index) =>
              part.added ? (
                <ins key={index} className="bg-emerald-200 font-medium text-emerald-900 no-underline">
                  {part.value}
                </ins>
              ) : (
                <span key={index}>{part.value}</span>
              ),
            )
        )}
      </div>
    </div>
  );
}

function show(value: ValueChange["before"]): string {
  if (value === null || value === "") return "not set";
  if (value === true) return "yes";
  if (value === false) return "no";
  if (value === "fixed" || value === "shuffle_within_block") return ORDER_MODE_LABELS[value];
  return String(value);
}

function ValueChanges({ changes }: { changes: ValueChange[] }) {
  if (changes.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-sm text-slate-700">
      {changes.map((change) => (
        <li key={change.field}>
          <span className="text-slate-500">{change.label}:</span> {show(change.before)}{" "}
          <span className="text-slate-500">changed to</span> {show(change.after)}
        </li>
      ))}
    </ul>
  );
}

function selection(ref: SelectionRef, noun: string): string {
  return ref ? `${noun} v${ref.versionNumber} (${ref.name})` : "none";
}

/** The difference between two protocol versions, as the publish review and the history show it. */
export function DiffView({ diff }: { diff: ProtocolDiff }) {
  if (!diff.from) {
    return (
      <p className="text-sm text-slate-700">
        There is no published version to compare with. Protocol v{diff.to.versionNumber} would be the first published
        version, with {diff.tasksAdded.length} task{diff.tasksAdded.length === 1 ? "" : "s"}.
      </p>
    );
  }
  if (!diff.hasChanges) {
    return (
      <p className="text-sm text-slate-700">
        No differences. Protocol v{diff.to.versionNumber} has the same content as Protocol v{diff.from.versionNumber}.
      </p>
    );
  }
  const { ordering } = diff;
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        Changes from Protocol v{diff.from.versionNumber} ({diff.from.status}) to Protocol v{diff.to.versionNumber} (
        {diff.to.status}).
      </p>

      {diff.contentChanges.length > 0 && (
        <Section title="Texts changed" count={diff.contentChanges.length}>
          <div className="space-y-4">
            {diff.contentChanges.map((change) => (
              <TextDiff key={change.field} change={change} />
            ))}
          </div>
        </Section>
      )}

      {diff.consentChange && (
        <Section title="Consent changed">
          <p className="text-sm text-slate-700">
            {selection(diff.consentChange.before, "Consent")} <span className="text-slate-500">changed to</span>{" "}
            {selection(diff.consentChange.after, "Consent")}
          </p>
        </Section>
      )}

      {diff.questionnaireChanges.length > 0 && (
        <Section title="Questionnaires changed" count={diff.questionnaireChanges.length}>
          <ul className="space-y-0.5 text-sm text-slate-700">
            {diff.questionnaireChanges.map((change) => (
              <li key={change.slot}>
                <span className="text-slate-500">{change.label}:</span> {selection(change.before, "version")}{" "}
                <span className="text-slate-500">changed to</span> {selection(change.after, "version")}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {diff.tasksAdded.length > 0 && (
        <Section title="Tasks added" count={diff.tasksAdded.length}>
          <ul className="space-y-2">
            {diff.tasksAdded.map((task) => (
              <li key={task.taskKey} className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
                <span className="mr-2 font-mono font-semibold text-emerald-700" aria-hidden="true">
                  +
                </span>
                <span className="font-medium text-slate-900">
                  {task.position}. {task.title || task.taskKey}
                </span>{" "}
                <span className="font-mono text-xs text-slate-500">{task.taskKey}</span>
                {!task.enabled && (
                  <Badge variant="incomplete" size="sm" className="ml-2">
                    Disabled
                  </Badge>
                )}
                <p className="mt-1 whitespace-pre-wrap text-slate-700">{task.participantPrompt || "(no prompt)"}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {diff.tasksRemoved.length > 0 && (
        <Section title="Tasks removed" count={diff.tasksRemoved.length}>
          <ul className="space-y-2">
            {diff.tasksRemoved.map((task) => (
              <li key={task.taskKey} className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm">
                <span className="mr-2 font-mono font-semibold text-rose-700" aria-hidden="true">
                  -
                </span>
                <span className="font-medium text-slate-900">
                  {task.position}. {task.title || task.taskKey}
                </span>{" "}
                <span className="font-mono text-xs text-slate-500">{task.taskKey}</span>
                <p className="mt-1 whitespace-pre-wrap text-slate-700">{task.participantPrompt || "(no prompt)"}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {diff.tasksChanged.length > 0 && (
        <Section title="Tasks changed" count={diff.tasksChanged.length}>
          <ul className="space-y-4">
            {diff.tasksChanged.map((task) => (
              <li key={task.taskKey} className="space-y-2 rounded-md border border-slate-200 p-3">
                <p className="text-sm">
                  <span className="font-medium text-slate-900">{task.title || task.taskKey}</span>{" "}
                  <span className="font-mono text-xs text-slate-500">{task.taskKey}</span>
                  {task.enabledChange && (
                    <Badge variant="warning" size="sm" className="ml-2">
                      {task.enabledChange.after ? "Enabled (was disabled)" : "Disabled (was enabled)"}
                    </Badge>
                  )}
                </p>
                {task.promptChange && <TextDiff change={task.promptChange} />}
                {task.textChanges.map((change) => (
                  <TextDiff key={change.field} change={change} />
                ))}
                <ValueChanges changes={task.valueChanges} />
                {task.followups.added.map((followup) => (
                  <p key={`added-${followup.followupKey}`} className="text-sm text-slate-700">
                    <span className="text-slate-500">Follow-up added:</span> &quot;{followup.promptText}&quot;
                  </p>
                ))}
                {task.followups.removed.map((followup) => (
                  <p key={`removed-${followup.followupKey}`} className="text-sm text-slate-700">
                    <span className="text-slate-500">Follow-up removed:</span> &quot;{followup.promptText}&quot;
                  </p>
                ))}
                {task.followups.changed.map((followup) => (
                  <div key={`changed-${followup.followupKey}`} className="space-y-1">
                    {followup.text && <TextDiff change={followup.text} />}
                    <ValueChanges
                      changes={followup.values.map((value) => ({ ...value, label: `Follow-up ${value.label.toLowerCase()}` }))}
                    />
                  </div>
                ))}
                {task.followups.reordered && <p className="text-sm text-slate-700">Follow-ups were reordered.</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {ordering.changed && (
        <Section title="Ordering changed">
          {ordering.blocksChanged && (
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              {(
                [
                  ["Blocks before", ordering.blocksBefore],
                  ["Blocks after", ordering.blocksAfter],
                ] as const
              ).map(([label, blocks]) => (
                <div key={label}>
                  <p className="text-xs font-medium text-slate-500">{label}</p>
                  <ol className="list-inside list-decimal text-slate-700">
                    {blocks.map((block) => (
                      <li key={block.key}>
                        {block.title || block.key} <span className="text-slate-500">({ORDER_MODE_LABELS[block.orderMode]})</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          )}
          {diff.tasksReordered.length > 0 && (
            <ul className="space-y-0.5 text-sm text-slate-700">
              {diff.tasksReordered.map((task) => (
                <li key={task.taskKey}>
                  <span className="font-medium text-slate-900">{task.title || task.taskKey}</span>: position{" "}
                  <span className="tabular-nums">{task.positionBefore}</span>{" "}
                  <span className="text-slate-500">changed to</span>{" "}
                  <span className="tabular-nums">{task.positionAfter}</span>
                  {task.blockBefore !== task.blockAfter && (
                    <>
                      , block <span className="font-mono text-xs">{task.blockBefore}</span>{" "}
                      <span className="text-slate-500">changed to</span>{" "}
                      <span className="font-mono text-xs">{task.blockAfter}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
