/**
 * QuestionnaireAnswersView: read-only display of the questionnaires one session
 * submitted, as prompt and answer pairs in admin density. For the admin session
 * detail page. Import from "@/components/questionnaire".
 *
 * PROPS
 *
 *   responses   SessionQuestionnaireResponse[]   the result of
 *               questionnaires.getQuestionnaireResponsesForSession(ctx, sessionId)
 *               from "@dialect/research" (type also in questionnaireSchemas of "@dialect/domain").
 *   timeZone    string     IANA time zone for the submission time (the study's adminTimezone).
 *   emptyText?  string     shown when the session submitted no questionnaire.
 *   headingLevel? "h3" | "h4"   heading of each questionnaire. Default "h3".
 *   className?  string
 *
 * It has no card of its own: place it inside the card of the page section.
 * Works in a server component (no client state).
 */
import type { questionnaireSchemas } from "@dialect/domain";
import { Badge, cn } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

export interface QuestionnaireAnswersViewProps {
  responses: questionnaireSchemas.SessionQuestionnaireResponse[];
  timeZone: string;
  emptyText?: string;
  headingLevel?: "h3" | "h4";
  className?: string;
}

export function QuestionnaireAnswersView({
  responses,
  timeZone,
  emptyText = "No questionnaire was submitted in this session.",
  headingLevel: Heading = "h3",
  className,
}: QuestionnaireAnswersViewProps) {
  if (responses.length === 0) {
    return <p className={cn("text-sm text-slate-500", className)}>{emptyText}</p>;
  }
  return (
    <div className={cn("space-y-5", className)}>
      {responses.map((response) => (
        <section key={response.responseId} aria-label={response.questionnaire.name}>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Heading className="text-sm font-semibold text-slate-900">{response.questionnaire.name}</Heading>
            <Badge size="sm">
              <span className="font-mono">
                {response.questionnaire.key} v{response.questionnaire.versionNumber}
              </span>
            </Badge>
            <span className="text-xs text-slate-500 tabular-nums">
              Submitted {formatDateTime(response.submittedAt, timeZone)}
            </span>
          </div>
          <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {response.answers.map((answer) => (
              <div key={answer.itemId} className="grid grid-cols-1 gap-x-4 gap-y-0.5 px-3 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <dt className="text-sm text-slate-700">
                  {answer.prompt}
                  <span className="ml-2 font-mono text-xs text-slate-500">{answer.itemKey}</span>
                </dt>
                <dd className="text-sm break-words whitespace-pre-wrap text-slate-900">
                  {answer.display === null ? <span className="text-slate-500">Not answered</span> : answer.display}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
