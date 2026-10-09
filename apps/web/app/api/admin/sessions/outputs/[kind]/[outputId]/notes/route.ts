// POST /api/admin/sessions/outputs/:kind/:outputId/notes (spec 88). Body: { body }.
// kind is "translations" or "syntheses".
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { outputParamsSchema } from "../../../../_lib/params";

export const POST = apiRoute<{ kind: string; outputId: string }>(
  async (request, { params, ctx }) => {
    const { kind, outputId } = outputParamsSchema.parse(params);
    const body = await parseJsonBody(request, corpusSchemas.noteBodySchema);
    return jsonOk({
      note: await corpus.addNote(ctx, {
        entityType: corpusSchemas.outputEntityTypeFromKind(kind),
        entityId: outputId,
        body: body.body,
      }),
    });
  },
  { auth: "admin", route: "/api/admin/sessions/outputs/[kind]/[outputId]/notes" },
);
