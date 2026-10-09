// POST /api/admin/protocols/:id/tasks/:taskId/enabled   switch a task on or off. Body: { enabled }.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string; taskId: string }>(
  async (request, { params, ctx }) => {
    const { id, taskId } = protocolSchemas.taskParamsSchema.parse(params);
    const { expectedUpdatedAt, ...body } = await parseJsonBody(request, protocolSchemas.setTaskEnabledSchema);
    const options = { expectedUpdatedAt, protocolVersionId: id };
    return jsonOk(await protocols.setTaskEnabled(ctx, taskId, body.enabled, options));
  },
  { auth: "admin" },
);
