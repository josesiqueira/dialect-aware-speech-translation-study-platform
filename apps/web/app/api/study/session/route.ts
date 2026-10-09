// GET /api/study/session: the state of the cookie's session.
// Response: SessionResponse. `state` is null when there is no usable session
// (no cookie, unknown or expired token, abandoned session). A dead cookie is cleared.
import type { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { findParticipantSession, PUBLIC_READ } from "../_lib/participant";

export const GET = apiRoute(
  async (_request, { ctx }) => {
    const session = await findParticipantSession(ctx);
    const response: sessionSchemas.SessionResponse = {
      state: session ? await sessions.getParticipantState(ctx, session) : null,
    };
    return jsonOk(response);
  },
  { ...PUBLIC_READ, route: "/api/study/session" },
);
