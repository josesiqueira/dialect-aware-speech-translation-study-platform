// POST /api/study/output-review/start: selects the participant's recordings for
// the review and stores the plan, or keeps the state "preparing" while they are
// still being processed. The browser repeats it every few seconds while it
// waits. It never starts a model call. Response: StateResponse.
import type { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../../_lib/participant";

export const POST = apiRoute(
  async (_request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const response: sessionSchemas.StateResponse = { state: await sessions.participantStartReview(ctx, session) };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/output-review/start" },
);
