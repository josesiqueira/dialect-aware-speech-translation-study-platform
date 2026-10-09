// GET /api/admin/export/preview?...filters
// Counts of what the current filters select: sessions, utterances, audio files
// and total audio duration.
import { exportSchemas } from "@dialect/domain";
import { exports as dataExports } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request, { ctx }) => {
    const query = parseQuery(request, exportSchemas.exportPreviewQuery);
    const preview = await dataExports.previewExport(ctx, {
      filters: exportSchemas.filtersFromQuery(query),
      privacyTier: query.privacyTier,
    });
    return jsonOk({ preview });
  },
  { auth: "admin", route: "/api/admin/export/preview" },
);
