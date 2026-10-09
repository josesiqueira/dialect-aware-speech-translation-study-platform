// POST /api/study/english-check: the English vocabulary test (LexTALE) before
// the output review. Body: EnglishCheckBody, one yes or no per item in the order
// of the state's items. Response: StateResponse. The server scores the answers.
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../_lib/participant";

export const POST = apiRoute(
  async (request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const body = await parseJsonBody(request, sessionSchemas.englishCheckBodySchema);
    const response: sessionSchemas.StateResponse = { state: await sessions.participantEnglishCheck(ctx, session, body) };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/english-check" },
);
