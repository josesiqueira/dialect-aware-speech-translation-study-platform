// POST /api/admin/protocols/:id/tasks/:taskId/clone   copy a task, placed after the original.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string; taskId: string }>(
  async (request, { params, ctx }) => {
    const { id, taskId } = protocolSchemas.taskParamsSchema.parse(params);
    const { expectedUpdatedAt } = await parseJsonBody(request, protocolSchemas.concurrencySchema);
    return jsonOk(await protocols.cloneTask(ctx, taskId, { expectedUpdatedAt, protocolVersionId: id }));
  },
  { auth: "admin" },
);
