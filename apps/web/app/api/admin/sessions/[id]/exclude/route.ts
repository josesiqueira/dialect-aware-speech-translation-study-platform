// POST /api/admin/sessions/:id/exclude (spec 70, 116). Body: { reason }.
// Excludes the session from analysis. No row and no file is deleted.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { sessionParamsSchema } from "../../_lib/params";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const { id } = sessionParamsSchema.parse(params);
    const body = await parseJsonBody(request, corpusSchemas.excludeBodySchema);
    return jsonOk(await corpus.excludeSession(ctx, { sessionId: id, reason: body.reason }));
  },
  { auth: "admin", route: "/api/admin/sessions/[id]/exclude" },
);
