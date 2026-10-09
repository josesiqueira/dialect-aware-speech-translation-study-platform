// POST /api/admin/ai/prompts/:id/retire   retire the active version without a replacement
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    return jsonOk({ prompt: await aiConfig.retirePromptVersion(ctx, id) });
  },
  { auth: "admin", route: "/api/admin/ai/prompts/[id]/retire" },
);
