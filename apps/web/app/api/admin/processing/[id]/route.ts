// GET /api/admin/processing/:id   one batch with its frozen configuration,
// job counts and failed jobs
import { processingSchemas } from "@dialect/domain";
import { processing } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const GET = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => {
    const { id } = processingSchemas.batchIdParamsSchema.parse(params);
    return jsonOk({ batch: await processing.getBatch(ctx, id) });
  },
  { auth: "admin", route: "/api/admin/processing/[id]" },
);
