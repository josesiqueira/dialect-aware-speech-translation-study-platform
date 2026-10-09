// GET /api/admin/protocols/:id/validate   the publish check: blocking errors and warnings.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const GET = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    return jsonOk(await protocols.validateProtocolForPublish(ctx, id));
  },
  { auth: "admin" },
);
