// POST /api/admin/ai/configs/:id/clone   new draft with the content of this version
// Optional body { "useActivePrompt": true }: the draft links the active version
// of the prompt instead of the version the source config pins.
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    // The body is optional: an empty request clones the version as it is.
    const hasBody = (await request.clone().text()).trim().length > 0;
    const options = hasBody ? await parseJsonBody(request, aiConfigSchemas.cloneConfigBody) : {};
    return jsonOk({ config: await aiConfig.cloneModelConfig(ctx, id, options) });
  },
  { auth: "admin", route: "/api/admin/ai/configs/[id]/clone" },
);
