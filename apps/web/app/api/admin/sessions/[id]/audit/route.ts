// GET /api/admin/sessions/:id/audit (spec 44): audit entries of the session and
// of its utterances, recordings, transcripts and outputs. Query: page, pageSize.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";
import { sessionParamsSchema } from "../../_lib/params";

export const GET = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const { id } = sessionParamsSchema.parse(params);
    const query = parseQuery(request, corpusSchemas.auditQuerySchema);
    return jsonOk(await corpus.getSessionAuditHistory(ctx, id, { page: query.page, pageSize: query.pageSize }));
  },
  { auth: "admin", route: "/api/admin/sessions/[id]/audit" },
);
