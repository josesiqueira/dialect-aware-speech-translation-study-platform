// GET    /api/admin/protocols/:id   one version with tasks, follow-ups, consent and questionnaires.
// PUT    /api/admin/protocols/:id   edit a draft. Body: changed fields and expectedUpdatedAt.
// DELETE /api/admin/protocols/:id   delete a draft.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

type Params = { id: string };

export const GET = apiRoute<Params>(
  async (_request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    return jsonOk(await protocols.getProtocolVersion(ctx, id));
  },
  { auth: "admin" },
);

export const PUT = apiRoute<Params>(
  async (request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    const body = await parseJsonBody(request, protocolSchemas.updateProtocolDraftSchema);
    return jsonOk(await protocols.updateProtocolDraft(ctx, id, body));
  },
  { auth: "admin" },
);

export const DELETE = apiRoute<Params>(
  async (_request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    return jsonOk(await protocols.deleteProtocolDraft(ctx, id));
  },
  { auth: "admin" },
);
