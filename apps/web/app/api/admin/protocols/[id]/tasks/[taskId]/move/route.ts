// POST /api/admin/protocols/:id/tasks/:taskId/move   one step up or down. Body: { direction }.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string; taskId: string }>(
  async (request, { params, ctx }) => {
    const { id, taskId } = protocolSchemas.taskParamsSchema.parse(params);
    const { expectedUpdatedAt, ...body } = await parseJsonBody(request, protocolSchemas.moveSchema);
    const options = { expectedUpdatedAt, protocolVersionId: id };
    return jsonOk(await protocols.moveTask(ctx, taskId, body.direction, options));
  },
  { auth: "admin" },
);
