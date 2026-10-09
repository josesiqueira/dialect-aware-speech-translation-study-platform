// GET /api/admin/questionnaires/:id/diff?against=<version id>
// What changed from the version `against` (the older one) to version :id.
// Without `against`: compared with the previous published version of the same
// key, or with nothing (every item counts as added) when there is none.
import { questionnaireSchemas } from "@dialect/domain";
import { questionnaires } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

export const GET = apiRoute<{ id: string }>(
  async (request, { ctx, params }) => {
    const { id } = questionnaireSchemas.versionParamSchema.parse(params);
    const { against } = parseQuery(request, questionnaireSchemas.diffQuerySchema);
    const fromId = against ?? (await questionnaires.findPreviousPublishedVersionId(ctx, id));
    const diff = await questionnaires.diffQuestionnaireVersions(ctx, fromId, id);
    return jsonOk({ diff } satisfies questionnaireSchemas.QuestionnaireDiffResponse);
  },
  { auth: "admin", route: "/api/admin/questionnaires/[id]/diff" },
);
