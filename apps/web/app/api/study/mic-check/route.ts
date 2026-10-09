// POST /api/study/mic-check: the participant confirmed the microphone check.
// Body: MicCheckBody (technical settings only, JSON). Response: StateResponse.
// The test recording stays in the browser. This endpoint takes no audio, and no
// other endpoint accepts microphone check audio (spec 6.3, 160.4).
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../_lib/participant";

export const POST = apiRoute(
  async (request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const body = await parseJsonBody(request, sessionSchemas.micCheckBodySchema);
    const response: sessionSchemas.StateResponse = { state: await sessions.confirmMicCheck(ctx, session, body) };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/mic-check" },
);
