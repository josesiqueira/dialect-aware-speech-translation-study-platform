// POST /api/admin/transcripts/:id/verify (spec 17, 60). Verifies the current
// revision. The body names the revision the researcher looked at; a stale id
// gives 409 CONFLICT.
import { transcriptSchemas } from "@dialect/domain";
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const body = await parseJsonBody(request, transcriptSchemas.verifyTranscriptBodySchema);
    return jsonOk(await transcripts.verifyTranscript(ctx, { ...body, transcriptId: params.id }));
  },
  { auth: "admin", route: "/api/admin/transcripts/[id]/verify" },
);
