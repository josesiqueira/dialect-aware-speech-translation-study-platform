// POST /api/admin/processing/preview   resolve the selection and the estimated
// workload of a batch without creating it
import { processingSchemas } from "@dialect/domain";
import { processing } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, processingSchemas.previewBatchSchema);
    const preview = await processing.previewBatch(ctx, body);
    // The utterance ids can be thousands. The wizard only needs the counts.
    const { utteranceIds, ...configuration } = preview.configuration;
    return jsonOk({ preview: { ...preview, configuration: { ...configuration, utteranceCount: utteranceIds.length } } });
  },
  { auth: "admin", route: "/api/admin/processing/preview" },
);
