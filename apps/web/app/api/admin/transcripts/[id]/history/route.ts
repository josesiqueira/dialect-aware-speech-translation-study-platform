// GET /api/admin/transcripts/:id/history (spec 18). All revisions, newest first.
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const GET = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => jsonOk(await transcripts.getTranscriptHistory(ctx, params.id)),
  { auth: "admin", route: "/api/admin/transcripts/[id]/history" },
);
