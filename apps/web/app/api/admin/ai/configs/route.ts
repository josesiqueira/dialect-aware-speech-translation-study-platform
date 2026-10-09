// GET  /api/admin/ai/configs   list model config versions, plus which AI providers the server offers
// POST /api/admin/ai/configs   create a draft version of a model config key
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request, { ctx }) => {
    const query = parseQuery(request, aiConfigSchemas.listConfigsQuery);
    const study = await aiConfig.resolveStudy(ctx, query.studyId);
    const configs = await aiConfig.listModelConfigs(ctx, { studyId: study.id, key: query.key, stage: query.stage });
    // Only names and a yes or no per provider. The API key never leaves the server (spec 26).
    return jsonOk({ configs, providers: aiConfig.listProviderStatus(ctx) });
  },
  { auth: "admin", route: "/api/admin/ai/configs" },
);

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, aiConfigSchemas.createConfigBody);
    const study = await aiConfig.resolveStudy(ctx, body.studyId);
    const config = await aiConfig.createModelConfigDraft(ctx, { ...body, studyId: study.id });
    return jsonOk({ config });
  },
  { auth: "admin", route: "/api/admin/ai/configs" },
);
