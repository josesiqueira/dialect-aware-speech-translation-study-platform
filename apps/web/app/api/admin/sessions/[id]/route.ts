// GET /api/admin/sessions/:id (spec 44, 45, 60): the complete Session Detail.
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { sessionParamsSchema } from "../_lib/params";

export const GET = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => {
    const { id } = sessionParamsSchema.parse(params);
    return jsonOk(await corpus.getSessionDetail(ctx, id));
  },
  { auth: "admin", route: "/api/admin/sessions/[id]" },
);
