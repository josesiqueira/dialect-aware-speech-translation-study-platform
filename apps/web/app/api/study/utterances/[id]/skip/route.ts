// POST /api/study/utterances/:id/skip: skip an optional follow-up turn.
// No body. Response: StateResponse. 409 INVALID_STATE when the turn must be answered.
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../../../_lib/participant";

export const POST = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = sessionSchemas.idParamSchema.parse(params);
    const session = await requireParticipantSession(ctx);
    const response: sessionSchemas.StateResponse = {
      state: await sessions.skipTurn(ctx, session, { utteranceId: id }),
    };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/utterances/[id]/skip" },
);
