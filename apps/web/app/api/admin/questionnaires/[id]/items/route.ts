// POST /api/admin/questionnaires/:id/items   add an item at the end of a draft
import { questionnaireSchemas } from "@dialect/domain";
import { questionnaires } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { ctx, params }) => {
    const { id } = questionnaireSchemas.versionParamSchema.parse(params);
    const body = await parseJsonBody(request, questionnaireSchemas.addItemBodySchema);
    const version = await questionnaires.addItem(ctx, id, body);
    return jsonOk({ version } satisfies questionnaireSchemas.QuestionnaireVersionResponse);
  },
  { auth: "admin", route: "/api/admin/questionnaires/[id]/items" },
);
