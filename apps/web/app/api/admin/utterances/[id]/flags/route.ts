// POST /api/admin/utterances/:id/flags (spec 66, 71). Flags the utterance, or
// one of its transcripts when the body has a transcriptId. A flag is not an exclusion.
import { transcriptSchemas } from "@dialect/domain";
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const { transcriptId, ...body } = await parseJsonBody(request, transcriptSchemas.addFlagBodySchema);
    return jsonOk(
      await transcripts.addFlag(ctx, {
        ...body,
        entityType: transcriptId ? "transcript" : "utterance",
        entityId: transcriptId ?? params.id,
        utteranceId: params.id,
      }),
    );
  },
  { auth: "admin", route: "/api/admin/utterances/[id]/flags" },
);
