// POST /api/admin/ai/prompts/:id/clone   new draft with the content of this version
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    return jsonOk({ prompt: await aiConfig.clonePromptVersion(ctx, id) });
  },
  { auth: "admin", route: "/api/admin/ai/prompts/[id]/clone" },
);
