// POST /api/admin/login (spec 39). Body: { "password": string }.
// 200 { ok: true } and the session cookie, 401 UNAUTHORIZED, or 429 RATE_LIMITED.
import { z } from "zod";
import { loginAdmin } from "@/lib/server/admin-auth";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

const bodySchema = z.object({ password: z.string().min(1).max(1024) });

export const POST = apiRoute(
  async (request, { ctx }) => {
    const { password } = await parseJsonBody(request, bodySchema);
    await loginAdmin(ctx, request, password);
    return jsonOk({ ok: true });
  },
  { auth: "public", sameOrigin: true, route: "/api/admin/login" },
);
