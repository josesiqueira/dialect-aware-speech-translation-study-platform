// GET /api/admin/dashboard (spec 42, 60): operational study health.
// Query: days (1 to 90, default 14) for the sessions per day.
import { z } from "zod";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

const querySchema = z.object({ days: z.coerce.number().int().min(1).max(90).optional() });

export const GET = apiRoute(
  async (request, { ctx }) => {
    const query = parseQuery(request, querySchema);
    const study = await corpus.resolveStudy(ctx.db);
    return jsonOk(await corpus.getDashboard(ctx, study.id, { days: query.days }));
  },
  { auth: "admin", route: "/api/admin/dashboard" },
);
