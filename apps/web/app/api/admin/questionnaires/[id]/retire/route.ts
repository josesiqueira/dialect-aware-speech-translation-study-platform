// POST /api/admin/questionnaires/:id/retire   retire a published version
import { questionnaireSchemas } from "@dialect/domain";
import { questionnaires } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = questionnaireSchemas.versionParamSchema.parse(params);
    const version = await questionnaires.retireQuestionnaireVersion(ctx, id);
    return jsonOk({ version } satisfies questionnaireSchemas.QuestionnaireVersionResponse);
  },
  { auth: "admin", route: "/api/admin/questionnaires/[id]/retire" },
);
