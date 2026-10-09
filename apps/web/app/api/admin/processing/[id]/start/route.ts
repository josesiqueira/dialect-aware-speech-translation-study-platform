// POST /api/admin/processing/:id/start   start a draft batch
import { processingSchemas } from "@dialect/domain";
import { processing } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => {
    const { id } = processingSchemas.batchIdParamsSchema.parse(params);
    return jsonOk({ batch: await processing.startBatch(ctx, id) });
  },
  { auth: "admin", route: "/api/admin/processing/[id]/start" },
);
