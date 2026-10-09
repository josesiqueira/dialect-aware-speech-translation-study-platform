// PUT    /api/admin/questionnaires/:id/items/:itemId   change one item of a draft
// DELETE /api/admin/questionnaires/:id/items/:itemId   remove one item of a draft
import { questionnaireSchemas } from "@dialect/domain";
import { questionnaires } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

const route = "/api/admin/questionnaires/[id]/items/[itemId]";

export const PUT = apiRoute<{ id: string; itemId: string }>(
  async (request, { ctx, params }) => {
    const { id, itemId } = questionnaireSchemas.itemParamSchema.parse(params);
    const body = await parseJsonBody(request, questionnaireSchemas.updateItemBodySchema);
    await questionnaires.assertItemInVersion(ctx, id, itemId);
    const version = await questionnaires.updateItem(ctx, itemId, body);
    return jsonOk({ version } satisfies questionnaireSchemas.QuestionnaireVersionResponse);
  },
  { auth: "admin", route },
);

export const DELETE = apiRoute<{ id: string; itemId: string }>(
  async (_request, { ctx, params }) => {
    const { id, itemId } = questionnaireSchemas.itemParamSchema.parse(params);
    await questionnaires.assertItemInVersion(ctx, id, itemId);
    const version = await questionnaires.deleteItem(ctx, itemId);
    return jsonOk({ version } satisfies questionnaireSchemas.QuestionnaireVersionResponse);
  },
  { auth: "admin", route },
);
