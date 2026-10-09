// POST /api/admin/sessions/:id/utterances/:utteranceId/exclude (spec 70). Body: { reason }.
// Sets the status "excluded" with the reason. The recording and all outputs are kept.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { utteranceParamsSchema } from "../../../../_lib/params";

export const POST = apiRoute<{ id: string; utteranceId: string }>(
  async (request, { params, ctx }) => {
    const { id, utteranceId } = utteranceParamsSchema.parse(params);
    const body = await parseJsonBody(request, corpusSchemas.excludeBodySchema);
    return jsonOk(await corpus.excludeUtterance(ctx, { sessionId: id, utteranceId, reason: body.reason }));
  },
  { auth: "admin", route: "/api/admin/sessions/[id]/utterances/[utteranceId]/exclude" },
);
