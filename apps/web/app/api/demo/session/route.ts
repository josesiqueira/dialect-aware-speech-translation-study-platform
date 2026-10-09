// GET    /api/demo/session: the open demo session of the cookie (or null) and
//                           what the demo page may offer.
// POST   /api/demo/session: start a demo session. Body: { acknowledged: true, locale?, browserInfo? }.
//                           Only after the visitor accepted the recording notice.
// DELETE /api/demo/session: end the demo session ("Clear and start again").
//                           Its data is deleted unless the study keeps demo data.
import { demoSchemas } from "@dialect/domain";
import { demo } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import {
  DEMO_READ,
  DEMO_WRITE,
  endDemoSession,
  findDemoSession,
  limitVisitor,
  requireDemoCaller,
  setDemoCookie,
} from "../_lib/demo";

export const dynamic = "force-dynamic";

export const GET = apiRoute(
  async () => {
    const caller = await requireDemoCaller();
    const session = await findDemoSession(caller.ctx);
    const response: demoSchemas.DemoSessionResponse = {
      session: session ? await demo.getDemoSessionInfo(caller.ctx, session) : null,
      access: caller.access,
    };
    return jsonOk(response);
  },
  { ...DEMO_READ, route: "/api/demo/session" },
);

export const POST = apiRoute(
  async (request) => {
    const caller = await requireDemoCaller();
    const body = await parseJsonBody(request, demoSchemas.startDemoSessionBodySchema);
    await limitVisitor(caller, request, "session");
    // A session that is still open is ended first, so its data is not left behind.
    await endDemoSession(caller);
    const userAgent = body.browserInfo?.userAgent ?? request.headers.get("user-agent")?.slice(0, 500);
    const started = await demo.startDemoSession(caller.ctx, {
      acknowledged: body.acknowledged,
      locale: body.locale ?? null,
      browserInfo: { ...body.browserInfo, ...(userAgent ? { userAgent } : {}) },
      isAdmin: caller.isAdmin,
    });
    await setDemoCookie(started.token, started.tokenExpiresAt);
    const response: demoSchemas.StartDemoSessionResponse = { session: started.info, access: caller.access };
    return jsonOk(response);
  },
  { ...DEMO_WRITE, route: "/api/demo/session" },
);

export const DELETE = apiRoute(
  async () => {
    const caller = await requireDemoCaller();
    return jsonOk(await endDemoSession(caller));
  },
  { ...DEMO_WRITE, route: "/api/demo/session" },
);
