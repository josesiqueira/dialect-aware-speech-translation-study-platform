// POST /api/admin/transcripts/:id/revisions (spec 18, 60). Saves a new revision
// of an existing human transcript. An ASR transcript is rejected.
import { transcriptSchemas } from "@dialect/domain";
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const body = await parseJsonBody(request, transcriptSchemas.saveRevisionBodySchema);
    return jsonOk(await transcripts.saveRevisionForTranscript(ctx, { ...body, transcriptId: params.id }));
  },
  { auth: "admin", route: "/api/admin/transcripts/[id]/revisions" },
);
