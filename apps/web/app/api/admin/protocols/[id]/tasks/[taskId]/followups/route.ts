// POST /api/admin/protocols/:id/tasks/:taskId/followups   add a predefined follow-up text.
import { protocolSchemas } from "@dialect/domain";
import { protocols } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string; taskId: string }>(
  async (request, { params, ctx }) => {
    const { id, taskId } = protocolSchemas.taskParamsSchema.parse(params);
    const { expectedUpdatedAt, ...body } = await parseJsonBody(request, protocolSchemas.addFollowupSchema);
    const options = { expectedUpdatedAt, protocolVersionId: id };
    return jsonOk(await protocols.addFollowup(ctx, taskId, body, options));
  },
  { auth: "admin" },
);
