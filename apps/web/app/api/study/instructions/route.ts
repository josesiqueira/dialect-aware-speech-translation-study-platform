// POST /api/study/instructions: the participant read the instructions.
// Creates the session's task sequence. No body. Response: StateResponse.
import type { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../_lib/participant";

export const POST = apiRoute(
  async (_request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const response: sessionSchemas.StateResponse = { state: await sessions.acknowledgeInstructions(ctx, session) };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/instructions" },
);
