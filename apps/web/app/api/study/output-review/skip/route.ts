// POST /api/study/output-review/skip: "Skip this part". Ends the English check,
// the review and the post-review questionnaire; answers given so far stay.
// Response: StateResponse (the debrief).
import type { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../../_lib/participant";

export const POST = apiRoute(
  async (_request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const response: sessionSchemas.StateResponse = { state: await sessions.participantSkipReview(ctx, session) };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/output-review/skip" },
);
