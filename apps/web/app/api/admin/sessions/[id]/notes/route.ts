// POST /api/admin/sessions/:id/notes (spec 88). Body: { body }. Adds an internal researcher note.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { sessionParamsSchema } from "../../_lib/params";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    const { id } = sessionParamsSchema.parse(params);
    const body = await parseJsonBody(request, corpusSchemas.noteBodySchema);
    return jsonOk({ note: await corpus.addNote(ctx, { entityType: "session", entityId: id, body: body.body }) });
  },
  { auth: "admin", route: "/api/admin/sessions/[id]/notes" },
);
