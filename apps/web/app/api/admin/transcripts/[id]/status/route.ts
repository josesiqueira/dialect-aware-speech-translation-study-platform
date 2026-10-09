// POST /api/admin/transcripts/:id/status (spec 17). Body { status: "needs_review" | "draft" }:
// asks for a second review, or takes the request back. Verified is set only by /verify.
import { transcriptSchemas } from "@dialect/domain";
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const body = await parseJsonBody(request, transcriptSchemas.setTranscriptStatusBodySchema);
    return jsonOk(await transcripts.setTranscriptStatus(ctx, { ...body, transcriptId: params.id }));
  },
  { auth: "admin", route: "/api/admin/transcripts/[id]/status" },
);
