// POST /api/admin/logout (spec 39). Deletes the session cookie. Always 200 { ok: true },
// also without a session, so the Sign Out button never fails.
//
// POST /api/admin/logout?rejected-cookie-only=1 removes only a cookie that the
// session check refuses (for example one issued before a sign-out in another
// browser). It never ends a valid session and writes no audit row. The login
// page calls it, because a page cannot remove a cookie while it renders.
import { clearRejectedAdminCookie, logoutAdmin } from "@/lib/server/admin-auth";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const POST = apiRoute(
  async (request, { ctx }) => {
    if (new URL(request.url).searchParams.get("rejected-cookie-only") === "1") {
      await clearRejectedAdminCookie();
    } else {
      await logoutAdmin(ctx);
    }
    return jsonOk({ ok: true });
  },
  { auth: "public", sameOrigin: true, route: "/api/admin/logout" },
);
