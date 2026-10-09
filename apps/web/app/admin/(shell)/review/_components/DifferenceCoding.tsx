"use client";

import { diffWords } from "diff";
import { useMemo } from "react";
import {
  DIFFERENCE_CATEGORIES,
  TRANSCRIPT_TYPE_LABELS,
  type DifferenceCategory,
  transcriptSchemas,
  type TranscriptType,
} from "@dialect/domain";
import { Checkbox, FormField, Select, TextInput } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { DIFFERENCE_CATEGORY_LABELS } from "./labels";

// The pairs offered on the page. The first one is the default (spec 19).
export const CODING_PAIRS = [
  { key: "asr:human_dialect", source: "asr", target: "human_dialect" },
  { key: "asr:asr_corrected", source: "asr", target: "asr_corrected" },
  { key: "asr_corrected:human_dialect", source: "asr_corrected", target: "human_dialect" },
  { key: "human_dialect:normalized", source: "human_dialect", target: "normalized" },
] as const satisfies readonly { key: string; source: TranscriptType; target: TranscriptType }[];

export type CodingPairKey = (typeof CODING_PAIRS)[number]["key"];
export type CodingDraft = { categories: DifferenceCategory[]; notes: string };

/**
 * The categories offered for a pair. A recognition error can only be coded when
 * the pair involves a recognizer output, so B versus C does not offer it. A
 * category that is already checked (a coding stored before this rule) stays
 * visible, so it can be read and unchecked.
 */
export function offeredCategories(
  pair: { source: TranscriptType; target: TranscriptType },
  checked: readonly DifferenceCategory[],
): DifferenceCategory[] {
  const forPair = transcriptSchemas.differenceCategoriesForPair(pair.source, pair.target);
  return DIFFERENCE_CATEGORIES.filter((category) => forPair.includes(category) || checked.includes(category));
}

export function pairLabel(pair: { source: TranscriptType; target: TranscriptType }): string {
  return `${TRANSCRIPT_TYPE_LABELS[pair.source]} vs ${TRANSCRIPT_TYPE_LABELS[pair.target]}`;
}

export interface DifferenceCodingProps {
  pairKey: CodingPairKey;
  onPairChange: (pair: CodingPairKey) => void;
  source: transcriptSchemas.TranscriptRevisionView | null;
  target: transcriptSchemas.TranscriptRevisionView | null;
  /** True when one of the two transcripts has unsaved text in its editor. */
  pairHasUnsavedText: boolean;
  /** What the checkboxes show: the unsaved choice, or the latest saved coding of this annotator. */
  value: CodingDraft;
  onChange: (value: CodingDraft) => void;
  dirty: boolean;
  /** Latest codings of the selected transcript pair by all annotators, newest first. */
  latestForPair: transcriptSchemas.DifferenceAnnotationView[];
  historyCount: number;
  annotatorLabel: string;
  schemeVersion: string | null;
  timeZone: string;
  disabled: boolean;
  error: string | null;
}

function ComparedText({ label, parts }: { label: string; parts: { value: string; differs: boolean }[] }) {
  return (
    <div className="grid grid-cols-[2.5rem_1fr] gap-2">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      <p lang="fi" className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
        {parts.map((part, index) =>
          part.differs ? (
            <mark key={index} className="rounded-sm bg-amber-100 text-slate-900 underline decoration-amber-800 underline-offset-2">
              {part.value}
            </mark>
          ) : (
            <span key={index}>{part.value}</span>
          ),
        )}
      </p>
    </div>
  );
}

/**
 * Utterance-level difference coding for one pair of transcript revisions.
 * Several categories may be checked. Saving adds a row; earlier codings are kept.
 */
export function DifferenceCoding({
  pairKey,
  onPairChange,
  source,
  target,
  pairHasUnsavedText,
  value,
  onChange,
  dirty,
  latestForPair,
  historyCount,
  annotatorLabel,
  schemeVersion,
  timeZone,
  disabled,
  error,
}: DifferenceCodingProps) {
  const pair = CODING_PAIRS.find((candidate) => candidate.key === pairKey) ?? CODING_PAIRS[0];
  const sourceLetter = TRANSCRIPT_TYPE_LABELS[pair.source];
  const targetLetter = TRANSCRIPT_TYPE_LABELS[pair.target];
  const ready = source !== null && target !== null;

  const comparison = useMemo(() => {
    if (!source || !target) return null;
    const parts = diffWords(source.text, target.text);
    return {
      identical: parts.every((part) => !part.added && !part.removed),
      source: parts.filter((part) => !part.added).map((part) => ({ value: part.value, differs: Boolean(part.removed) })),
      target: parts.filter((part) => !part.removed).map((part) => ({ value: part.value, differs: Boolean(part.added) })),
    };
  }, [source, target]);

  const toggle = (category: DifferenceCategory, checked: boolean) => {
    const next = checked ? [...value.categories, category] : value.categories.filter((entry) => entry !== category);
    onChange({ ...value, categories: DIFFERENCE_CATEGORIES.filter((entry) => next.includes(entry)) });
  };

  const others = latestForPair.filter((annotation) => annotation.annotatorLabel !== annotatorLabel);
  const ownEarlier = latestForPair.find(
    (annotation) =>
      annotation.annotatorLabel === annotatorLabel &&
      (annotation.sourceTranscriptRevisionId !== source?.id || annotation.targetTranscriptRevisionId !== target?.id),
  );
  const describe = (annotation: transcriptSchemas.DifferenceAnnotationView) =>
    annotation.categories.length > 0
      ? annotation.categories.map((category) => DIFFERENCE_CATEGORY_LABELS[category] ?? category).join(", ")
      : "no difference coded";
  const revisions = (annotation: transcriptSchemas.DifferenceAnnotationView) =>
    `${sourceLetter} revision ${annotation.sourceRevisionNumber ?? "?"} vs ${targetLetter} revision ${annotation.targetRevisionNumber ?? "?"}`;

  return (
    <section aria-labelledby="difference-coding-heading" className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="difference-coding-heading" className="text-sm font-semibold text-slate-900">
            Difference coding
          </h3>
          {dirty && <span className="text-xs text-amber-800">Unsaved changes</span>}
        </div>
        <FormField label="Pair being coded" hideLabel className="w-40">
          <Select
            value={pairKey}
            disabled={disabled}
            onChange={(event) => onPairChange(event.target.value as CodingPairKey)}
            options={CODING_PAIRS.map((candidate) => ({ value: candidate.key, label: pairLabel(candidate) }))}
            className="py-1.5"
          />
        </FormField>
      </div>

      {!ready ? (
        <p className="mt-2 text-sm text-slate-500">
          {source === null && target === null
            ? `${sourceLetter} and ${targetLetter} have no saved text yet.`
            : `${source === null ? sourceLetter : targetLetter} has no saved text yet.`}{" "}
          Differences can be coded once both transcripts exist.
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-slate-500">
            Coding {sourceLetter} revision {source.revisionNumber} against {targetLetter} revision {target.revisionNumber}, for
            the whole utterance. Check every category that applies.
            {pairHasUnsavedText && " Unsaved transcript text is saved first, and the coding then refers to the new revision."}
          </p>

          {comparison && (
            <div className="mt-2 space-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <ComparedText label={sourceLetter} parts={comparison.source} />
              <ComparedText label={targetLetter} parts={comparison.target} />
              <p className="text-xs text-slate-500">
                {comparison.identical
                  ? "The two saved texts are identical."
                  : "Marked words differ between the two saved texts. The marking is a reading aid computed in the browser, not a coding."}
              </p>
            </div>
          )}

          <fieldset className="mt-3" disabled={disabled}>
            <legend className="sr-only">Difference categories for {pairLabel(pair)}</legend>
            <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {offeredCategories(pair, value.categories).map((category) => (
                <Checkbox
                  key={category}
                  label={DIFFERENCE_CATEGORY_LABELS[category]}
                  checked={value.categories.includes(category)}
                  onChange={(event) => toggle(category, event.target.checked)}
                />
              ))}
            </div>
          </fieldset>

          <FormField className="mt-3" label="Coding note" error={error}>
            <TextInput
              value={value.notes}
              disabled={disabled}
              maxLength={5000}
              onChange={(event) => onChange({ ...value, notes: event.target.value })}
            />
          </FormField>
        </>
      )}

      {(ownEarlier || others.length > 0 || historyCount > 0) && (
        <div className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
          {ownEarlier && (
            <p>
              Your coding of earlier revisions ({revisions(ownEarlier)}): {describe(ownEarlier)}. Code the pair again if it
              still applies to the current revisions.
            </p>
          )}
          {others.map((annotation) => (
            <p key={annotation.id}>
              <span className="font-medium text-slate-700">{annotation.annotatorLabel}</span>, {revisions(annotation)},{" "}
              <span className="tabular-nums">{formatDateTime(annotation.createdAt, timeZone)}</span>: {describe(annotation)}
              {annotation.notes ? ` (${annotation.notes})` : ""}
            </p>
          ))}
          <p className="text-slate-500">
            {historyCount} coding {historyCount === 1 ? "record" : "records"} stored for this utterance
            {schemeVersion ? `, scheme version ${schemeVersion}` : ""}. Saving adds a record and keeps the earlier ones.
          </p>
        </div>
      )}
    </section>
  );
}
