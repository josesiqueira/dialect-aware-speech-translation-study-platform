// GET /api/admin/export?table=<name>&format=csv|json|jsonl&...filters
// Streams one export table. Rows are read from the database page by page while
// the response is sent. The export is audited as export.create (spec 131).
import { Readable } from "node:stream";
import { exportSchemas } from "@dialect/domain";
import { exports as dataExports } from "@dialect/research";
import { apiRoute, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request, { ctx }) => {
    const query = parseQuery(request, exportSchemas.tableExportQuery);
    const result = await dataExports.openTableExport(ctx, {
      table: query.table,
      format: query.format,
      filters: exportSchemas.filtersFromQuery(query),
      privacyTier: query.privacyTier,
      includeFreeTextAnswers: query.includeFreeTextAnswers,
    });
    return new Response(Readable.toWeb(result.stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.fileName}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
  { auth: "admin", route: "/api/admin/export" },
);
