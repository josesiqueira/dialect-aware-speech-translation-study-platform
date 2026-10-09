// POST /api/admin/utterances/:id/transcripts/:type/revisions (spec 18).
// Saves the text of A* (asr_corrected), B (human_dialect) or C (normalized) as a
// new revision and creates the transcript when it does not exist yet. The type
// asr is rejected: ASR revisions are created only by the processing pipeline.
import { transcriptSchemas } from "@dialect/domain";
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string; type: string }>(
  async (request, { params, ctx }) => {
    const { id, type } = transcriptSchemas.utteranceTranscriptParamsSchema.parse(params);
    const body = await parseJsonBody(request, transcriptSchemas.saveRevisionBodySchema);
    return jsonOk(await transcripts.saveTranscriptRevision(ctx, { ...body, utteranceId: id, type }));
  },
  { auth: "admin", route: "/api/admin/utterances/[id]/transcripts/[type]/revisions" },
);
