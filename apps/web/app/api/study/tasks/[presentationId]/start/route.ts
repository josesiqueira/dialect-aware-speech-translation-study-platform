// POST /api/study/tasks/:presentationId/start: the task is now shown to the participant.
// No body. Response: StateResponse. Only the next task of the session's sequence can start.
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../../../_lib/participant";

export const POST = apiRoute<{ presentationId: string }>(
  async (_request, { ctx, params }) => {
    const { presentationId } = sessionSchemas.presentationParamSchema.parse(params);
    const session = await requireParticipantSession(ctx);
    const response: sessionSchemas.StateResponse = {
      state: await sessions.startTask(ctx, session, presentationId),
    };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/tasks/[presentationId]/start" },
);
