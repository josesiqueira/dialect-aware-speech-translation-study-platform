// GET /api/admin/export/jobs/:id/download
// Streams the finished archive from storage. The download is audited as
// export.download (spec 131). The archive has no public URL (spec 110.10).
import { Readable } from "node:stream";
import { exportSchemas } from "@dialect/domain";
import { exports as dataExports } from "@dialect/research";
import { apiRoute } from "@/lib/server/api";

export const GET = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = exportSchemas.exportJobParams.parse(params);
    const download = await dataExports.openExportDownload(ctx, id);
    return new Response(Readable.toWeb(download.stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": download.contentType,
        "Content-Length": String(download.sizeBytes),
        "Content-Disposition": `attachment; filename="${download.fileName}"`,
        "X-Content-Type-Options": "nosniff",
        "X-Checksum-Sha256": download.sha256,
      },
    });
  },
  { auth: "admin", route: "/api/admin/export/jobs/[id]/download" },
);
