// POST /api/study/consent. Body: ConsentBody. Response: StateResponse.
// 400 VALIDATION_ERROR (details.reason "required_consent_not_accepted") when a
// required item is refused: nothing is stored.
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../_lib/participant";

export const POST = apiRoute(
  async (request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const body = await parseJsonBody(request, sessionSchemas.consentBodySchema);
    const response: sessionSchemas.StateResponse = { state: await sessions.recordConsent(ctx, session, body) };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/consent" },
);
