// POST /api/admin/sessions/:id/include (spec 70): takes an excluded session back into analysis.
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { sessionParamsSchema } from "../../_lib/params";

export const POST = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => {
    const { id } = sessionParamsSchema.parse(params);
    return jsonOk(await corpus.includeSession(ctx, { sessionId: id }));
  },
  { auth: "admin", route: "/api/admin/sessions/[id]/include" },
);
