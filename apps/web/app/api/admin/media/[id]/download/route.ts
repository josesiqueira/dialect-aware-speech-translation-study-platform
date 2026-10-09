// GET /api/admin/media/:id/download (spec 60, 123): the file as an attachment
// with a pseudonymous name such as P-7K4M9Q_U-03_source.wav. Every download
// writes a media.download audit row (spec 132). The inline stream that the
// audio player uses (GET /api/admin/media/:id) is not audited.
// An export archive is never served by either route (404).
import { corpus } from "@dialect/research";
import { apiRoute } from "@/lib/server/api";
import { streamMedia } from "../../_lib/stream";

export const GET = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const asset = await corpus.getMediaForStreaming(ctx, params.id);
    const downloadName = await corpus.getMediaDownloadName(ctx, asset);
    const response = await streamMedia(ctx, request, asset, { downloadName });
    // Only a response that sends file content counts as a download.
    if (response.ok) {
      try {
        await corpus.recordMediaDownload(ctx, asset, downloadName);
      } catch (error) {
        // No audit row, no file: close the storage stream and fail the request.
        await response.body?.cancel();
        throw error;
      }
    }
    return response;
  },
  { auth: "admin", route: "/api/admin/media/[id]/download" },
);
