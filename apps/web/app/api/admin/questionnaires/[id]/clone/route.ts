// POST /api/admin/questionnaires/:id/clone   copy a version into a new draft of the same key
import { questionnaireSchemas } from "@dialect/domain";
import { questionnaires } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = questionnaireSchemas.versionParamSchema.parse(params);
    const version = await questionnaires.cloneQuestionnaireVersion(ctx, id);
    return jsonOk({ version } satisfies questionnaireSchemas.QuestionnaireVersionResponse);
  },
  { auth: "admin", route: "/api/admin/questionnaires/[id]/clone" },
);
