// GET  /api/admin/ai/prompts   list prompt versions (optional filters: key, stage, studyId)
// POST /api/admin/ai/prompts   create a draft version of a prompt key
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request, { ctx }) => {
    const query = parseQuery(request, aiConfigSchemas.listPromptsQuery);
    const study = await aiConfig.resolveStudy(ctx, query.studyId);
    const prompts = await aiConfig.listPromptVersions(ctx, { studyId: study.id, key: query.key, stage: query.stage });
    return jsonOk({ prompts });
  },
  { auth: "admin", route: "/api/admin/ai/prompts" },
);

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, aiConfigSchemas.createPromptBody);
    const study = await aiConfig.resolveStudy(ctx, body.studyId);
    const prompt = await aiConfig.createPromptDraft(ctx, { ...body, studyId: study.id });
    return jsonOk({ prompt });
  },
  { auth: "admin", route: "/api/admin/ai/prompts" },
);
