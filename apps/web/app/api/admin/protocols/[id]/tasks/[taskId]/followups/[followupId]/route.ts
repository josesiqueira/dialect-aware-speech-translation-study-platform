// PUT    /api/admin/protocols/:id/tasks/:taskId/followups/:followupId   change a follow-up.
// DELETE /api/admin/protocols/:id/tasks/:taskId/followups/:followupId   delete a follow-up (?expectedUpdatedAt=).
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody, parseQuery } from "@/lib/server/api";

type Params = { id: string; taskId: string; followupId: string };

export const PUT = apiRoute<Params>(
  async (request, { params, ctx }) => {
    const { id, taskId, followupId } = protocolSchemas.followupParamsSchema.parse(params);
    const { expectedUpdatedAt, ...changes } = await parseJsonBody(request, protocolSchemas.updateFollowupSchema);
    return jsonOk(
      await protocols.updateFollowup(ctx, followupId, changes, { expectedUpdatedAt, protocolVersionId: id, taskId }),
    );
  },
  { auth: "admin" },
);

export const DELETE = apiRoute<Params>(
  async (request, { params, ctx }) => {
    const { id, taskId, followupId } = protocolSchemas.followupParamsSchema.parse(params);
    const { expectedUpdatedAt } = parseQuery(request, protocolSchemas.concurrencyQuerySchema);
    return jsonOk(
      await protocols.deleteFollowup(ctx, followupId, { expectedUpdatedAt, protocolVersionId: id, taskId }),
    );
  },
  { auth: "admin" },
);
