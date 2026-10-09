// GET /api/admin/settings (spec 59): operational state, limits and technical status.
// PUT /api/admin/settings: changes the given fields (see settingsUpdateSchema).
// No provider API is called here. The API key is never returned.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { settingsRuntime } from "./_lib/runtime";

export const GET = apiRoute(
  async (_request, { ctx }) => {
    const study = await corpus.resolveStudy(ctx.db);
    return jsonOk(await corpus.getSettings(ctx, study.id, settingsRuntime()));
  },
  { auth: "admin", route: "/api/admin/settings" },
);

export const PUT = apiRoute(
  async (request, { ctx }) => {
    const changes = await parseJsonBody(request, corpusSchemas.settingsUpdateSchema);
    const study = await corpus.resolveStudy(ctx.db);
    return jsonOk(await corpus.updateSettings(ctx, study.id, changes, settingsRuntime()));
  },
  { auth: "admin", route: "/api/admin/settings" },
);
