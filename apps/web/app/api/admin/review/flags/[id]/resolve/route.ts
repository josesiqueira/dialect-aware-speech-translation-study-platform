// POST /api/admin/review/flags/:id/resolve. Marks a flag on an utterance or a
// transcript as resolved (spec 71). The body may be empty or { annotatorLabel }.
import { transcriptSchemas } from "@dialect/domain";
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute<{ id: string }>(
  async (request, { params, ctx }) => {
    // An empty body is allowed: the flag id is all that is needed.
    const raw: unknown = await request.json().catch(() => ({}));
    const body = transcriptSchemas.resolveFlagBodySchema.parse(raw ?? {});
    return jsonOk(await transcripts.resolveFlag(ctx, { flagId: params.id, ...body }));
  },
  { auth: "admin", route: "/api/admin/review/flags/[id]/resolve" },
);
