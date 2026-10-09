// POST /api/study/utterances: create (or get) the utterance of the current turn.
// Body: CreateUtteranceBody. Response: CreateUtteranceResponse.
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../_lib/participant";

export const POST = apiRoute(
  async (request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const body = await parseJsonBody(request, sessionSchemas.createUtteranceBodySchema);
    const response: sessionSchemas.CreateUtteranceResponse = await sessions.createUtterance(ctx, session, body);
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/utterances" },
);
