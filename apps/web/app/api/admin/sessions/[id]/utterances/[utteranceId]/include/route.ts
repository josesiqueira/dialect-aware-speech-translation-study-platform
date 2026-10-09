// POST /api/admin/sessions/:id/utterances/:utteranceId/include (spec 70):
// an excluded utterance goes back to the status "submitted".
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { utteranceParamsSchema } from "../../../../_lib/params";

export const POST = apiRoute<{ id: string; utteranceId: string }>(
  async (_request, { params, ctx }) => {
    const { id, utteranceId } = utteranceParamsSchema.parse(params);
    return jsonOk(await corpus.includeUtterance(ctx, { sessionId: id, utteranceId }));
  },
  { auth: "admin", route: "/api/admin/sessions/[id]/utterances/[utteranceId]/include" },
);
