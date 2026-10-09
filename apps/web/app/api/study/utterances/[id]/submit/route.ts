// POST /api/study/utterances/:id/submit: accept the uploaded recording and advance.
// Body: SubmitUtteranceBody. Response: StateResponse. The browser releases its
// recording and moves on only after this response (spec 62).
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { PUBLIC_WRITE, requireParticipantSession } from "../../../_lib/participant";

export const POST = apiRoute<{ id: string }>(
  async (request, { ctx, params }) => {
    const { id } = sessionSchemas.idParamSchema.parse(params);
    const session = await requireParticipantSession(ctx);
    const body = await parseJsonBody(request, sessionSchemas.submitUtteranceBodySchema);
    const response: sessionSchemas.StateResponse = {
      state: await sessions.submitUtterance(ctx, session, {
        utteranceId: id,
        mediaAssetId: body.mediaAssetId,
        attemptCount: body.attemptCount ?? 1,
      }),
    };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/utterances/[id]/submit" },
);
