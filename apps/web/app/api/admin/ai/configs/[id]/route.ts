// GET    /api/admin/ai/configs/:id   one model config version
// PUT    /api/admin/ai/configs/:id   change a draft (an active or retired version is refused)
// DELETE /api/admin/ai/configs/:id   delete a draft
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

const route = "/api/admin/ai/configs/[id]";

export const GET = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    return jsonOk({ config: await aiConfig.getModelConfig(ctx, id) });
  },
  { auth: "admin", route },
);

export const PUT = apiRoute<{ id: string }>(
  async (request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    const body = await parseJsonBody(request, aiConfigSchemas.updateConfigBody);
    return jsonOk({ config: await aiConfig.updateModelConfigDraft(ctx, id, body) });
  },
  { auth: "admin", route },
);

export const DELETE = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    return jsonOk(await aiConfig.deleteModelConfigDraft(ctx, id));
  },
  { auth: "admin", route },
);
