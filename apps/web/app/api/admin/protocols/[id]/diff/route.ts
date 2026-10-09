// GET /api/admin/protocols/:id/diff?against=<id>
// What changed from version "against" to version :id. Without "against" the
// comparison is with the study's current protocol (nothing, for a first version).
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

export const GET = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    const { against } = parseQuery(request, protocolSchemas.diffQuerySchema);
    let fromId: string | null = against ?? null;
    if (!against) {
      const target = await protocols.getProtocolVersion(ctx, id);
      const current = await protocols.getCurrentProtocol(ctx, target.protocol.studyId);
      fromId = current && current.protocol.id !== id ? current.protocol.id : null;
    }
    return jsonOk(await protocols.diffProtocolVersions(ctx, fromId, id));
  },
  { auth: "admin" },
);
