// POST /api/study/output-review/items/:id/answer: the answers to one review
// screen, in order. Body: OutputReviewAnswerBody. Response: StateResponse.
// 400 VALIDATION_ERROR when a required answer is missing for this screen.
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../../../../_lib/participant";

export const POST = apiRoute<{ id: string }>(
  async (request, { ctx, params }) => {
    const { id } = sessionSchemas.outputReviewItemParamSchema.parse(params);
    const session = await requireParticipantSession(ctx);
    const body = await parseJsonBody(request, sessionSchemas.outputReviewAnswerBodySchema);
    const response: sessionSchemas.StateResponse = {
      state: await sessions.participantAnswerReview(ctx, session, id, body),
    };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/output-review/items/[id]/answer" },
);
