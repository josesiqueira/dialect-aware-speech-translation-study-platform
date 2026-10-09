// PUT    /api/admin/protocols/:id/tasks/:taskId   change a task of a draft.
// DELETE /api/admin/protocols/:id/tasks/:taskId   delete a task of a draft (?expectedUpdatedAt=).
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody, parseQuery } from "@/lib/server/api";

type Params = { id: string; taskId: string };

export const PUT = apiRoute<Params>(
  async (request, { params, ctx }) => {
    const { id, taskId } = protocolSchemas.taskParamsSchema.parse(params);
    const { expectedUpdatedAt, ...changes } = await parseJsonBody(request, protocolSchemas.updateTaskSchema);
    return jsonOk(await protocols.updateTask(ctx, taskId, changes, { expectedUpdatedAt, protocolVersionId: id }));
  },
  { auth: "admin" },
);

export const DELETE = apiRoute<Params>(
  async (request, { params, ctx }) => {
    const { id, taskId } = protocolSchemas.taskParamsSchema.parse(params);
    const { expectedUpdatedAt } = parseQuery(request, protocolSchemas.concurrencyQuerySchema);
    return jsonOk(await protocols.deleteTask(ctx, taskId, { expectedUpdatedAt, protocolVersionId: id }));
  },
  { auth: "admin" },
);
