// GET  /api/demo/purge-leftovers: how many demo sessions were left behind.
// POST /api/demo/purge-leftovers: the explicit admin action that removes them
//      (spec 80, 116). Body: { confirm: true }. Only while the study setting
//      demoPersist is false. Kept demo data is removed with the TEST and DEMO
//      data reset on the Settings page.
import { demoSchemas } from "@dialect/domain";
import { demo } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";

export const dynamic = "force-dynamic";

export const GET = apiRoute(
  async (_request, { ctx }) => {
    const leftovers = await demo.listLeftoverDemoSessions(ctx);
    return jsonOk({ sessions: leftovers.length, idleMinutes: demo.LEFTOVER_IDLE_MINUTES });
  },
  { auth: "admin", route: "/api/demo/purge-leftovers" },
);

export const POST = apiRoute(
  async (request, { ctx }) => {
    await parseJsonBody(request, demoSchemas.purgeLeftoversBodySchema);
    const response: demoSchemas.PurgeLeftoversResponse = await demo.purgeLeftoverDemoSessions(ctx);
    return jsonOk(response);
  },
  { auth: "admin", route: "/api/demo/purge-leftovers" },
);
