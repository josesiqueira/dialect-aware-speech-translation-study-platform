// Participant actions of the output review, each answering with the new state.
// The step checks use the same derivation as the state (state.ts), so the
// browser and the server always agree on what is allowed.
import type { DbOrTx } from "@dialect/db";
import type { sessionSchemas } from "@dialect/domain";
import type { ServiceContext } from "../context";
import type { MediaRow, SessionRef } from "./internal";
import { answerReviewItem, reviewAudioFile, skipOutputReview, startOutputReview, submitEnglishCheck } from "./output-review";
import { currentStepOf, getParticipantState } from "./state";

type ParticipantState = sessionSchemas.ParticipantState;

const stepOf = (session: SessionRef) => (tx: DbOrTx) => currentStepOf(tx, session.id);

export async function participantEnglishCheck(
  ctx: ServiceContext,
  session: SessionRef,
  body: sessionSchemas.EnglishCheckBody,
): Promise<ParticipantState> {
  await submitEnglishCheck(ctx, session, body, stepOf(session));
  return getParticipantState(ctx, session);
}

export async function participantStartReview(ctx: ServiceContext, session: SessionRef): Promise<ParticipantState> {
  await startOutputReview(ctx, session, stepOf(session));
  return getParticipantState(ctx, session);
}

export async function participantAnswerReview(
  ctx: ServiceContext,
  session: SessionRef,
  itemId: string,
  body: sessionSchemas.OutputReviewAnswerBody,
): Promise<ParticipantState> {
  await answerReviewItem(ctx, session, { itemId, body }, stepOf(session));
  return getParticipantState(ctx, session);
}

export async function participantSkipReview(ctx: ServiceContext, session: SessionRef): Promise<ParticipantState> {
  await skipOutputReview(ctx, session, stepOf(session));
  return getParticipantState(ctx, session);
}

export async function participantReviewAudio(
  ctx: ServiceContext,
  session: SessionRef,
  itemId: string,
  which: "source",
): Promise<MediaRow> {
  return reviewAudioFile(ctx, session, { itemId, which }, stepOf(session));
}
