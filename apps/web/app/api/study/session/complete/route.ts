// POST /api/study/session/complete: finish the study from the debrief step.
// Response: StateResponse with step "completed". The cookie is always cleared, so
// the next person at the same browser never sees this session (spec 137, 138).
import type { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { clearParticipantCookie } from "@/lib/server/participant-cookie";
import { PUBLIC_WRITE, requireParticipantSession } from "../../_lib/participant";

export const POST = apiRoute(
  async (_request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const response: sessionSchemas.StateResponse = { state: await sessions.completeSession(ctx, session) };
    await clearParticipantCookie();
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/session/complete" },
);
