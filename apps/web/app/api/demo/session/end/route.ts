// POST /api/demo/session/end: the same as DELETE /api/demo/session, for
// navigator.sendBeacon, which can only send POST. The demo page calls it when
// the page is left, so a demo session never stays open without its page.
import { apiRoute, jsonOk } from "@/lib/server/api";
import { DEMO_WRITE, endDemoSession, requireDemoCaller } from "../../_lib/demo";

export const dynamic = "force-dynamic";

export const POST = apiRoute(
  async () => {
    const caller = await requireDemoCaller();
    return jsonOk(await endDemoSession(caller));
  },
  { ...DEMO_WRITE, route: "/api/demo/session/end" },
);
