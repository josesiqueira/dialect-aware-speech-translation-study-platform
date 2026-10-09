// POST /api/study/session/withdraw: "End participation" (spec 86).
// Response: StateResponse with step "withdrawn" and the debrief content.
// The cookie is always cleared.
import type { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { clearParticipantCookie } from "@/lib/server/participant-cookie";
import { PUBLIC_WRITE, requireParticipantSession } from "../../_lib/participant";

export const POST = apiRoute(
  async (_request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const response: sessionSchemas.StateResponse = { state: await sessions.withdrawSession(ctx, session) };
    await clearParticipantCookie();
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/session/withdraw" },
);
