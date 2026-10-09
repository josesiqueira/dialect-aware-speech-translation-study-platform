// POST /api/admin/ai/prompts/:id/activate
// The draft becomes active and the previous active version of the key is
// retired. Model configs are not changed: the response lists the active configs
// that still use another version of this prompt.
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    return jsonOk(await aiConfig.activatePromptVersion(ctx, id));
  },
  { auth: "admin", route: "/api/admin/ai/prompts/[id]/activate" },
);
