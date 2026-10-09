// POST /api/admin/utterances/:id/annotations (spec 19). Adds a difference
// annotation for two transcript revisions of the utterance. Rows are never
// overwritten: coding the same pair again adds a row.
import { transcriptSchemas } from "@dialect/domain";
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const body = await parseJsonBody(request, transcriptSchemas.differenceAnnotationBodySchema);
    return jsonOk(await transcripts.saveDifferenceAnnotation(ctx, { ...body, utteranceId: params.id }));
  },
  { auth: "admin", route: "/api/admin/utterances/[id]/annotations" },
);
