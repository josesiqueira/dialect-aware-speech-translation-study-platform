// POST /api/study/session/locale. Body: SetLocaleBody ({ locale }). Response: StateResponse.
// The participant switched the language during the study: the study texts shown
// from then on follow it. 400 VALIDATION_ERROR (details.reason "unknown_locale")
// for a language the study does not offer.
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../../_lib/participant";

export const POST = apiRoute(
  async (request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const body = await parseJsonBody(request, sessionSchemas.setLocaleBodySchema);
    const response: sessionSchemas.StateResponse = { state: await sessions.setSessionLocale(ctx, session, body) };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/session/locale" },
);
