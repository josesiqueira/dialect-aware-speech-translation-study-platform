// GET    /api/admin/consents/:id   one consent version.
// PUT    /api/admin/consents/:id   edit a consent draft.
// DELETE /api/admin/consents/:id   delete a consent draft.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

type Params = { id: string };

export const GET = apiRoute<Params>(
  async (_request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    return jsonOk(await protocols.getConsentVersion(ctx, id));
  },
  { auth: "admin" },
);

export const PUT = apiRoute<Params>(
  async (request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    const body = await parseJsonBody(request, protocolSchemas.updateConsentDraftSchema);
    return jsonOk(await protocols.updateConsentDraft(ctx, id, body));
  },
  { auth: "admin" },
);

export const DELETE = apiRoute<Params>(
  async (_request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    return jsonOk(await protocols.deleteConsentDraft(ctx, id));
  },
  { auth: "admin" },
);
