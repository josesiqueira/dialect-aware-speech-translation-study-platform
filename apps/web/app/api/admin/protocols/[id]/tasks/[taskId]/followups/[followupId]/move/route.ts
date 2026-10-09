// POST /api/admin/protocols/:id/tasks/:taskId/followups/:followupId/move   one step up or down.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string; taskId: string; followupId: string }>(
  async (request, { params, ctx }) => {
    const { id, taskId, followupId } = protocolSchemas.followupParamsSchema.parse(params);
    const { expectedUpdatedAt, direction } = await parseJsonBody(request, protocolSchemas.moveSchema);
    return jsonOk(
      await protocols.moveFollowup(ctx, followupId, direction, { expectedUpdatedAt, protocolVersionId: id, taskId }),
    );
  },
  { auth: "admin" },
);
