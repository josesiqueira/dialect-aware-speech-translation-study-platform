// POST /api/admin/sessions/:id/utterances/:utteranceId/notes (spec 88). Body: { body }.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { utteranceParamsSchema } from "../../../../_lib/params";

export const POST = apiRoute<{ id: string; utteranceId: string }>(
  async (request, { params, ctx }) => {
    const { id, utteranceId } = utteranceParamsSchema.parse(params);
    const body = await parseJsonBody(request, corpusSchemas.noteBodySchema);
    return jsonOk({
      note: await corpus.addNote(ctx, { entityType: "utterance", entityId: utteranceId, sessionId: id, body: body.body }),
    });
  },
  { auth: "admin", route: "/api/admin/sessions/[id]/utterances/[utteranceId]/notes" },
);
