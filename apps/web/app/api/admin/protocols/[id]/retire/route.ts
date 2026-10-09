// POST /api/admin/protocols/:id/retire   retire a published version that is not current.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    return jsonOk(await protocols.retireProtocol(ctx, id));
  },
  { auth: "admin" },
);
