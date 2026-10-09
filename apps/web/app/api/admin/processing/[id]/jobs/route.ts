// GET /api/admin/processing/:id/jobs   jobs of a batch, paginated, optional
// filter by status
import { processingSchemas } from "@dialect/domain";
import { processing } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

export const GET = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const { id } = processingSchemas.batchIdParamsSchema.parse(params);
    const query = parseQuery(request, processingSchemas.listBatchJobsQuerySchema);
    return jsonOk(await processing.listBatchJobs(ctx, id, query));
  },
  { auth: "admin", route: "/api/admin/processing/[id]/jobs" },
);
