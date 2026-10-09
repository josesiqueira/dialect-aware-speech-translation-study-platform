// POST /api/admin/questionnaires/:id/items/:itemId/move   { direction: "up" | "down" }
import { questionnaireSchemas } from "@dialect/domain";
import { questionnaires } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string; itemId: string }>(
  async (request, { ctx, params }) => {
    const { id, itemId } = questionnaireSchemas.itemParamSchema.parse(params);
    const { direction } = await parseJsonBody(request, questionnaireSchemas.moveItemBodySchema);
    await questionnaires.assertItemInVersion(ctx, id, itemId);
    const version = await questionnaires.moveItem(ctx, itemId, direction);
    return jsonOk({ version } satisfies questionnaireSchemas.QuestionnaireVersionResponse);
  },
  { auth: "admin", route: "/api/admin/questionnaires/[id]/items/[itemId]/move" },
);
