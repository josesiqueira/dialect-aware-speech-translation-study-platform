// GET /api/admin/review/queue (spec 46, 60, 134).
// Query: page, pageSize (default 50), condition (repeatable: unreviewed, b_missing,
// c_missing, a_star_missing, needs_review, flagged), taskType, protocolVersionId,
// mode (repeatable, default research), search, region, regionItemKey, includeExcluded.
import { transcriptSchemas } from "@dialect/domain";
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request, { ctx }) => {
    const query = parseQuery(request, transcriptSchemas.reviewQueueQuerySchema);
    const { filters, pagination } = transcripts.queueArgumentsFromQuery(query);
    return jsonOk(await transcripts.listReviewQueue(ctx, filters, pagination));
  },
  { auth: "admin", route: "/api/admin/review/queue" },
);
