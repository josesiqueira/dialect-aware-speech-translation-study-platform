// Reading the questionnaires a participant submitted, for the admin session detail page.
import { asc, eq, inArray } from "drizzle-orm";
import {
  questionnaireAnswers,
  questionnaireItems,
  questionnaireResponses,
  questionnaireVersions,
  sessions,
} from "@dialect/db";
import { AppError, questionnaireSchemas as schemas } from "@dialect/domain";
import type { ServiceContext } from "../context";

// One entry per submitted questionnaire:
//   {
//     responseId, submittedAt (ISO 8601),
//     questionnaire: { versionId, key, versionNumber, name },
//     answers: [{ itemId, itemKey, type, prompt, orderIndex, value, display }]
//   }
// `answers` lists every item of the questionnaire version in order. `value` is the
// stored value_json (null when not answered). `display` is the answer as text with
// option labels resolved, for example "25 to 34", "4 (scale 1 to 5)", "Yes",
// "Finnish; Swedish", or null when the item was not answered.
export type SessionQuestionnaireResponse = schemas.SessionQuestionnaireResponse;

// The submitted questionnaires of one session, oldest first. Throws NOT_FOUND for
// an unknown session. A session without submissions gives an empty array.
export async function getQuestionnaireResponsesForSession(
  ctx: ServiceContext,
  sessionId: string,
): Promise<SessionQuestionnaireResponse[]> {
  const [session] = await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) throw new AppError("NOT_FOUND", "The session does not exist.");

  const responses = await ctx.db
    .select({
      responseId: questionnaireResponses.id,
      submittedAt: questionnaireResponses.submittedAt,
      versionId: questionnaireVersions.id,
      key: questionnaireVersions.key,
      versionNumber: questionnaireVersions.versionNumber,
      name: questionnaireVersions.name,
    })
    .from(questionnaireResponses)
    .innerJoin(questionnaireVersions, eq(questionnaireVersions.id, questionnaireResponses.questionnaireVersionId))
    .where(eq(questionnaireResponses.sessionId, sessionId))
    .orderBy(asc(questionnaireResponses.submittedAt), asc(questionnaireVersions.key));
  if (responses.length === 0) return [];

  const items = await ctx.db
    .select()
    .from(questionnaireItems)
    .where(
      inArray(
        questionnaireItems.questionnaireVersionId,
        responses.map((response) => response.versionId),
      ),
    )
    .orderBy(asc(questionnaireItems.orderIndex), asc(questionnaireItems.itemKey));
  const answers = await ctx.db
    .select()
    .from(questionnaireAnswers)
    .where(
      inArray(
        questionnaireAnswers.responseId,
        responses.map((response) => response.responseId),
      ),
    );
  const valueByResponseAndItem = new Map(
    answers.map((answer) => [`${answer.responseId}:${answer.questionnaireItemId}`, answer.valueJson]),
  );

  return responses.map((response) => ({
    responseId: response.responseId,
    submittedAt: response.submittedAt.toISOString(),
    questionnaire: {
      versionId: response.versionId,
      key: response.key,
      versionNumber: response.versionNumber,
      name: response.name,
    },
    answers: items
      .filter((item) => item.questionnaireVersionId === response.versionId)
      .map((item) => {
        const value = valueByResponseAndItem.get(`${response.responseId}:${item.id}`) ?? null;
        return {
          itemId: item.id,
          itemKey: item.itemKey,
          type: item.type,
          prompt: item.prompt,
          orderIndex: item.orderIndex,
          value,
          display: schemas.formatAnswerForDisplay({ type: item.type, config: item.configJson ?? {} }, value),
        };
      }),
  }));
}
