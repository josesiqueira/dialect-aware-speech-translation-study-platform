// POST /api/admin/consents/:id/clone   copy a consent version into a new draft. Item ids are kept.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    return jsonOk(await protocols.cloneConsentVersion(ctx, id));
  },
  { auth: "admin" },
);
