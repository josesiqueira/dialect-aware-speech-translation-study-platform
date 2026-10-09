// PATCH /api/admin/sessions/outputs/:kind/:outputId/status (spec 45 "flag output").
// kind is "translations" or "syntheses". Body: { status, reasonCode?, notes? } with
// status generated, reviewed or excluded. Only the status changes: the text, the
// audio and the provenance of an output are immutable.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { outputParamsSchema } from "../../../../_lib/params";

export const PATCH = apiRoute<{ kind: string; outputId: string }>(
  async (request, { params, ctx }) => {
    const { kind, outputId } = outputParamsSchema.parse(params);
    const body = await parseJsonBody(request, corpusSchemas.outputStatusBodySchema);
    return jsonOk(
      await corpus.setOutputStatus(ctx, {
        entityType: corpusSchemas.outputEntityTypeFromKind(kind),
        entityId: outputId,
        ...body,
      }),
    );
  },
  { auth: "admin", route: "/api/admin/sessions/outputs/[kind]/[outputId]/status" },
);
