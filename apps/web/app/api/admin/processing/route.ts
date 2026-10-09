// GET  /api/admin/processing   list of processing batches with job counts
// POST /api/admin/processing   create a draft batch from the wizard input
import { processingSchemas } from "@dialect/domain";
import { processing } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request, { ctx }) => {
    const query = parseQuery(request, processingSchemas.listBatchesQuerySchema);
    return jsonOk(await processing.listBatches(ctx, query));
  },
  { auth: "admin", route: "/api/admin/processing" },
);

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, processingSchemas.createBatchSchema);
    return jsonOk({ batch: await processing.createBatch(ctx, body) });
  },
  { auth: "admin", route: "/api/admin/processing" },
);
