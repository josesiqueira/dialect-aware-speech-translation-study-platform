// GET /api/admin/ai/configs/compare?a=<id>&b=<id>   difference from config a to config b (spec 142)
import { aiConfigSchemas } from "@dialect/domain";
import { aiConfig } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request, { ctx }) => {
    const query = parseQuery(request, aiConfigSchemas.compareQuery);
    return jsonOk({ diff: await aiConfig.diffModelConfigs(ctx, query.a, query.b) });
  },
  { auth: "admin", route: "/api/admin/ai/configs/compare" },
);
