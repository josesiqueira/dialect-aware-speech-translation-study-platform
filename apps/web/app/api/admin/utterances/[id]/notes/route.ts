// POST /api/admin/utterances/:id/notes (spec 88). Adds an internal researcher
// note to the utterance, or to one of its transcripts when the body has a transcriptId.
import { transcriptSchemas } from "@dialect/domain";
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const { transcriptId, ...body } = await parseJsonBody(request, transcriptSchemas.addNoteBodySchema);
    return jsonOk(
      await transcripts.addNote(ctx, {
        ...body,
        entityType: transcriptId ? "transcript" : "utterance",
        entityId: transcriptId ?? params.id,
        utteranceId: params.id,
      }),
    );
  },
  { auth: "admin", route: "/api/admin/utterances/[id]/notes" },
);
