// GET /api/admin/audit (spec 37.26): the admin audit log, newest first.
// Query: page, pageSize (default 50), entityType, entityId, action.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request, { ctx }) => {
    const { page, pageSize, ...filters } = parseQuery(request, corpusSchemas.auditQuerySchema);
    return jsonOk(await corpus.getAuditHistory(ctx, { ...filters, pagination: { page, pageSize } }));
  },
  { auth: "admin", route: "/api/admin/audit" },
);
