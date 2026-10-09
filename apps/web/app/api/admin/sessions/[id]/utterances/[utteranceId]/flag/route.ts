// PATCH /api/admin/sessions/:id/utterances/:utteranceId/flag (spec 71).
// Body: { flagged, notes?, reasonCode? }. A flag does not exclude the utterance.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { utteranceParamsSchema } from "../../../../_lib/params";

export const PATCH = apiRoute<{ id: string; utteranceId: string }>(
  async (request, { params, ctx }) => {
    const { id, utteranceId } = utteranceParamsSchema.parse(params);
    const body = await parseJsonBody(request, corpusSchemas.flagBodySchema);
    return jsonOk(await corpus.setUtteranceFlag(ctx, { sessionId: id, utteranceId, ...body }));
  },
  { auth: "admin", route: "/api/admin/sessions/[id]/utterances/[utteranceId]/flag" },
);
