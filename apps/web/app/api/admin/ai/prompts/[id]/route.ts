// GET    /api/admin/ai/prompts/:id   one prompt version
// PUT    /api/admin/ai/prompts/:id   change a draft (an active or retired version is refused)
// DELETE /api/admin/ai/prompts/:id   delete a draft
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

const route = "/api/admin/ai/prompts/[id]";

export const GET = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    return jsonOk({ prompt: await aiConfig.getPromptVersion(ctx, id) });
  },
  { auth: "admin", route },
);

export const PUT = apiRoute<{ id: string }>(
  async (request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    const body = await parseJsonBody(request, aiConfigSchemas.updatePromptBody);
    return jsonOk({ prompt: await aiConfig.updatePromptDraft(ctx, id, body) });
  },
  { auth: "admin", route },
);

export const DELETE = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    return jsonOk(await aiConfig.deletePromptDraft(ctx, id));
  },
  { auth: "admin", route },
);
