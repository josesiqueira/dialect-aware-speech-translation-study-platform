// POST /api/admin/protocols/:id/tasks   add a task to a draft, at the end of its block.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const { id } = protocolSchemas.idParamsSchema.parse(params);
    const { expectedUpdatedAt, ...input } = await parseJsonBody(request, protocolSchemas.addTaskSchema);
    return jsonOk(await protocols.addTask(ctx, id, input, { expectedUpdatedAt }));
  },
  { auth: "admin" },
);
