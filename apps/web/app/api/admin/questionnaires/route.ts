// GET  /api/admin/questionnaires   every questionnaire of the study, grouped by key
// POST /api/admin/questionnaires   create an empty draft { key, name, description? }
import { questionnaireSchemas } from "@dialect/domain";
import { questionnaires } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const GET = apiRoute(
  async (_request, { ctx }) => {
    const { studyId, adminTimezone } = await questionnaires.resolveQuestionnaireStudy(ctx);
    const body: questionnaireSchemas.ListQuestionnairesResponse = {
      studyId,
      adminTimezone,
      questionnaires: await questionnaires.listQuestionnaires(ctx, studyId),
    };
    return jsonOk(body);
  },
  { auth: "admin", route: "/api/admin/questionnaires" },
);

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, questionnaireSchemas.createDraftBodySchema);
    const { studyId } = await questionnaires.resolveQuestionnaireStudy(ctx);
    const version = await questionnaires.createQuestionnaireDraft(ctx, { studyId, ...body });
    return jsonOk({ version } satisfies questionnaireSchemas.QuestionnaireVersionResponse);
  },
  { auth: "admin", route: "/api/admin/questionnaires" },
);
