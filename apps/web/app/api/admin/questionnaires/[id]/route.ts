// GET    /api/admin/questionnaires/:id   one version with its items
// PUT    /api/admin/questionnaires/:id   save a draft { name?, description?, items? }
// DELETE /api/admin/questionnaires/:id   delete a draft
import { questionnaireSchemas } from "@dialect/domain";
import { questionnaires } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

const route = "/api/admin/questionnaires/[id]";

export const GET = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = questionnaireSchemas.versionParamSchema.parse(params);
    const version = await questionnaires.getQuestionnaireVersion(ctx, id);
    return jsonOk({ version } satisfies questionnaireSchemas.QuestionnaireVersionResponse);
  },
  { auth: "admin", route },
);

// With `items` the whole item list is replaced in one transaction (the editor's
// Save). Without it only the name and description change.
export const PUT = apiRoute<{ id: string }>(
  async (request, { ctx, params }) => {
    const { id } = questionnaireSchemas.versionParamSchema.parse(params);
    const body = await parseJsonBody(request, questionnaireSchemas.updateDraftBodySchema);
    const version =
      body.items !== undefined
        ? await questionnaires.saveQuestionnaireDraft(ctx, id, { ...body, items: body.items })
        : await questionnaires.updateQuestionnaireDraft(ctx, id, body);
    return jsonOk({ version } satisfies questionnaireSchemas.QuestionnaireVersionResponse);
  },
  { auth: "admin", route },
);

export const DELETE = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = questionnaireSchemas.versionParamSchema.parse(params);
    return jsonOk(await questionnaires.deleteQuestionnaireDraft(ctx, id));
  },
  { auth: "admin", route },
);
