// POST /api/admin/processing/:id/retry-failed   put the failed jobs of a batch
// back in the queue, under the same frozen configuration
import { processingSchemas } from "@dialect/domain";
import { processing } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => {
    const { id } = processingSchemas.batchIdParamsSchema.parse(params);
    return jsonOk(await processing.retryFailedJobs(ctx, id));
  },
  { auth: "admin", route: "/api/admin/processing/[id]/retry-failed" },
);
