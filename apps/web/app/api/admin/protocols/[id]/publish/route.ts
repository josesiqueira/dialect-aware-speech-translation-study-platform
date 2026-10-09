// POST /api/admin/protocols/:id/publish   check, publish and make current for new sessions.
// A failed check returns VALIDATION_ERROR with details.problems.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    return jsonOk(await protocols.publishProtocol(ctx, id));
  },
  { auth: "admin" },
);
