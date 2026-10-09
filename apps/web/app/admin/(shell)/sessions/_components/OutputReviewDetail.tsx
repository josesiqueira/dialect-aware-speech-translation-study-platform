"use client";

import type { corpusSchemas } from "@dialect/domain";
import { QuestionnaireAnswersView } from "@/components/questionnaire";
import { Badge, KeyValueList, tableClasses } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

type Detail = corpusSchemas.SessionDetail;
type Item = corpusSchemas.OutputReviewItemView;

const KIND_LABEL: Record<Item["kind"], string> = {
  practice: "Practice (v1)",
  utterance: "Own recording",
  check: "Check (v1)",
  audio: "Audio (v1)",
};

// The scale version of the current review questions (output-review-v2).
const CURRENT_SCALE = "output-review-v2";

const SAID_LABEL: Record<string, string> = { yes: "yes", partly: "partly", no: "no" };

function ratingText(value: unknown, path: string, cantJudge: string[]): string {
  if (cantJudge.includes(path)) return "can't say";
  return typeof value === "number" ? String(value) : "-";
}

function versionRatings(item: Item, slot: "1" | "2"): string {
  const versions = (item.ratings?.versions ?? {}) as Record<string, Record<string, unknown>>;
  const v = versions[slot] ?? {};
  return `meaning ${ratingText(v.meaning, `versions.${slot}.meaning`, item.cantJudge)}, representation ${ratingText(
    v.representation,
    `versions.${slot}.representation`,
    item.cantJudge,
  )}`;
}

/**
 * The English check, the output review and the post-review questionnaire of
 * one session (docs/ADMIN.md, "Output review"). Unlike the participant, the
 * researcher sees which translation condition was Version 1 and Version 2.
 */
export function OutputReviewDetail({ detail, timeZone }: { detail: Detail; timeZone: string }) {
  const { englishCheck, outputReview } = detail;
  if (!englishCheck && !outputReview && !detail.questionnaires.postReview) {
    return <p className="text-sm text-slate-500">This session had no output review.</p>;
  }
  return (
    <div className="space-y-4">
      <KeyValueList
        items={[
          {
            label: "English check (LexTALE)",
            value: englishCheck
              ? `${englishCheck.score.toFixed(2)} (words ${englishCheck.wordsCorrect}/40, nonwords ${englishCheck.nonwordsCorrect}/20), ${formatDateTime(englishCheck.submittedAt, timeZone)}`
              : "Not taken (off unless a researcher turns it on)",
          },
          {
            label: "Review",
            value: outputReview
              ? `${outputReview.status}${outputReview.skippedAtStep ? ` at ${outputReview.skippedAtStep}` : ""}, scale ${outputReview.scaleVersion}`
              : "Not reached",
          },
        ]}
      />
      {outputReview && outputReview.items.length > 0 && (
        <div className={tableClasses.wrapper}>
          <table className={tableClasses.table}>
            <thead className={tableClasses.thead}>
              <tr>
                <th scope="col" className={tableClasses.th}>#</th>
                <th scope="col" className={tableClasses.th}>Screen</th>
                <th scope="col" className={tableClasses.th}>Shown</th>
                <th scope="col" className={tableClasses.th}>Answers</th>
              </tr>
            </thead>
            <tbody className={tableClasses.tbody}>
              {outputReview.items.map((item) => (
                <tr key={item.id} className="align-top">
                  <td className="px-3 py-2 text-sm tabular-nums">{item.position}</td>
                  <td className="px-3 py-2 text-sm">
                    <Badge variant={item.kind === "utterance" ? "neutral" : "test"}>{KIND_LABEL[item.kind]}</Badge>
                  </td>
                  <td className="space-y-1 px-3 py-2 text-sm">
                    {item.sourceText && <p lang="fi">{item.sourceText}</p>}
                    <p lang="en">
                      <span className="font-medium">V1</span>
                      {item.version1.conditionKey ? ` (${item.version1.conditionKey})` : ""}
                      {item.changedSlot === 1 ? " (changed meaning)" : ""}: {item.version1.text}
                    </p>
                    <p lang="en">
                      <span className="font-medium">V2</span>
                      {item.version2.conditionKey ? ` (${item.version2.conditionKey})` : ""}
                      {item.changedSlot === 2 ? " (changed meaning)" : ""}: {item.version2.text}
                    </p>
                  </td>
                  <td className="space-y-1 px-3 py-2 text-sm">
                    {!item.answeredAt ? (
                      <span className="text-slate-500">Not answered</span>
                    ) : item.scaleVersion !== CURRENT_SCALE ? (
                      <pre className="whitespace-pre-wrap text-xs text-slate-600">{JSON.stringify(item.ratings)}</pre>
                    ) : (
                      <>
                        <p>
                          what you said:{" "}
                          {SAID_LABEL[String((item.ratings?.transcript as Record<string, unknown> | undefined)?.said)] ?? "-"}
                        </p>
                        <p>V1: {versionRatings(item, "1")}</p>
                        <p>V2: {versionRatings(item, "2")}</p>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <QuestionnaireAnswersView
        headingLevel="h4"
        timeZone={timeZone}
        responses={detail.questionnaires.postReview ? [detail.questionnaires.postReview] : []}
        emptyText={
          detail.questionnaires.postReviewExpected
            ? "The post-review questionnaire was not submitted."
            : "The protocol of this session has no post-review questionnaire."
        }
      />
    </div>
  );
}
