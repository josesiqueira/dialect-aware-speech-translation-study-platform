// POST /api/admin/ai/configs/:id/activate
// The draft becomes active and the previous active version of the key is
// retired. Existing model runs and batches keep the version they were made with.
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = aiConfigSchemas.idParams.parse(params);
    return jsonOk(await aiConfig.activateModelConfig(ctx, id));
  },
  { auth: "admin", route: "/api/admin/ai/configs/[id]/activate" },
);
