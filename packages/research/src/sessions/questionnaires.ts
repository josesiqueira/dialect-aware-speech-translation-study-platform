// Questionnaire submission by the participant (spec 11, 12, 37.23, 37.24).
// Answers are validated against the items of the questionnaire version that the
// session's protocol pins, never against the newest version.
import { asc, eq } from "drizzle-orm";
import {
  questionnaireAnswers,
  questionnaireItems,
  questionnaireResponses,
  sessions,
} from "@dialect/db";
import { AppError, questionnaireSchemas, type QuestionnaireKey, type sessionSchemas } from "@dialect/domain";
import type { ServiceContext } from "../context";
import {
  hasQuestionnaireResponse,
  invalidState,
  loadProtocol,
  lockActiveSession,
  type SessionRef,
} from "./internal";
import { deriveStep, getParticipantState } from "./state";

type ItemRow = typeof questionnaireItems.$inferSelect;

// Checks the answers with the shared rules of @dialect/domain
// (questionnaireSchemas.validateQuestionnaireAnswers, the same function the form
// uses in the browser) and returns the normalized value per answered item.
// Throws VALIDATION_ERROR with details.issues = [{ path: itemKey, message, code }].
export function validateAnswers(
  items: ItemRow[],
  answers: Record<string, unknown>,
): Array<{ item: ItemRow; value: unknown }> {
  const result = questionnaireSchemas.validateQuestionnaireAnswers(
    items.map((item) => ({
      itemKey: item.itemKey,
      type: item.type,
      prompt: item.prompt,
      helpText: item.helpText,
      required: item.required,
      config: item.configJson ?? {},
    })),
    answers,
  );
  if (!result.ok) {
    const order = new Map(items.map((item, index) => [item.itemKey, index]));
    const issues = Object.entries(result.errors)
      .map(([path, message]) => ({ path, message, code: result.errorCodes[path] }))
      .sort((a, b) => (order.get(a.path) ?? items.length) - (order.get(b.path) ?? items.length));
    throw new AppError("VALIDATION_ERROR", "Some answers are missing or not valid.", { issues });
  }
  return items
    .filter((item) => Object.prototype.hasOwnProperty.call(result.values, item.itemKey))
    .map((item) => ({ item, value: result.values[item.itemKey] }));
}

// Stores the answers of the background, the post-recording or the post-review questionnaire.
// The background questionnaire can only be answered after the speech tasks
// (spec 11), the post-recording questionnaire after the background one. A repeated
// submission returns the current state and stores nothing new.
export async function submitQuestionnaire(
  ctx: ServiceContext,
  session: SessionRef,
  input: { key: QuestionnaireKey; answers: Record<string, unknown> },
): Promise<sessionSchemas.ParticipantState> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    const protocol = await loadProtocol(tx, locked.protocolVersionId);
    const versionId =
      input.key === "background"
        ? protocol.backgroundQuestionnaireVersionId
        : input.key === "post_recording"
          ? protocol.postQuestionnaireVersionId
          : protocol.postReviewQuestionnaireVersionId;
    if (!versionId) throw new AppError("NOT_FOUND", "This study has no such questionnaire.");
    if (await hasQuestionnaireResponse(tx, locked.id, versionId)) return;

    const expected = input.key === "background" ? "background_questionnaire" : "post_questionnaire";
    if (locked.status !== expected) {
      throw invalidState("This questionnaire cannot be answered at this point of the study.", {
        status: locked.status,
        expected,
      });
    }
    // The post-review questionnaire comes after the output review, so its step is checked too.
    if (input.key === "post_review") {
      const step = await deriveStep(tx, locked, protocol);
      if (step !== "post_review") {
        throw invalidState("This questionnaire cannot be answered at this point of the study.", { step });
      }
    }

    const items = await tx
      .select()
      .from(questionnaireItems)
      .where(eq(questionnaireItems.questionnaireVersionId, versionId))
      .orderBy(asc(questionnaireItems.orderIndex));
    const accepted = validateAnswers(items, input.answers);

    const now = ctx.now();
    const [response] = await tx
      .insert(questionnaireResponses)
      .values({ sessionId: locked.id, questionnaireVersionId: versionId, submittedAt: now })
      .returning({ id: questionnaireResponses.id });
    if (!response) throw new AppError("DATABASE_ERROR", "The answers could not be stored.");
    if (accepted.length > 0) {
      await tx.insert(questionnaireAnswers).values(
        accepted.map(({ item, value }) => ({
          responseId: response.id,
          questionnaireItemId: item.id,
          valueJson: value,
        })),
      );
    }
    // After the background questionnaire the status "post_questionnaire" covers the
    // post-recording questionnaire (when the protocol has one) and the debrief.
    await tx
      .update(sessions)
      .set({ status: "post_questionnaire", lastActivityAt: now })
      .where(eq(sessions.id, locked.id));
  });
  return getParticipantState(ctx, session);
}
