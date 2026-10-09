// PATCH /api/admin/sessions/:id/flag (spec 60, 71). Body: { flagged, notes?, reasonCode? }.
// A flag asks for attention. It does not exclude the session.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { sessionParamsSchema } from "../../_lib/params";

export const PATCH = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const { id } = sessionParamsSchema.parse(params);
    const body = await parseJsonBody(request, corpusSchemas.flagBodySchema);
    return jsonOk(await corpus.setSessionFlag(ctx, { sessionId: id, ...body }));
  },
  { auth: "admin", route: "/api/admin/sessions/[id]/flag" },
);
