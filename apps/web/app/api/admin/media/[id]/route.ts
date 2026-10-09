// GET /api/admin/media/:id (spec 60, 135): inline streaming for the audio player,
// with HTTP Range support so seeking does not download the whole file.
// An export archive is never served here (404): it is downloaded only through
// GET /api/admin/export/jobs/:id/download, which writes an audit row.
// DELETE /api/admin/media/:id (spec 38, 111, 116): the audited media deletion
// workflow. Body: { reason, confirmationPhrase? }.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { streamMedia } from "../_lib/stream";

export const GET = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const asset = await corpus.getMediaForStreaming(ctx, params.id);
    return streamMedia(ctx, request, asset);
  },
  { auth: "admin", route: "/api/admin/media/[id]" },
);

export const DELETE = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const body = await parseJsonBody(request, corpusSchemas.mediaDeleteBodySchema);
    return jsonOk(await corpus.deleteMedia(ctx, { mediaAssetId: params.id, ...body }));
  },
  { auth: "admin", route: "/api/admin/media/[id]" },
);
