// GET /api/demo/media/:id: streams one audio file to the demo visitor, with
// HTTP Range support. Only a file of the caller's own demo session is served:
// its source recordings and the synthesized audio of its translations. The
// session is the one of the demo cookie, never an id from the request. Every
// other id, including every research asset, gives 404.
import { demoSchemas } from "@dialect/domain";
import { demo } from "@dialect/research";
import { apiRoute } from "@/lib/server/api";
import { streamMedia } from "../../../admin/media/_lib/stream";
import { DEMO_READ, requireDemoCaller, requireDemoSession } from "../../_lib/demo";

export const dynamic = "force-dynamic";

export const GET = apiRoute<{ id: string }>(
  async (request, { params }) => {
    const { id } = demoSchemas.mediaIdParamSchema.parse(params);
    const caller = await requireDemoCaller();
    const session = await requireDemoSession(caller.ctx);
    const asset = await demo.getDemoMediaForStreaming(caller.ctx, { sessionId: session.id, mediaAssetId: id });
    return streamMedia(caller.ctx, request, asset);
  },
  { ...DEMO_READ, route: "/api/demo/media/[id]" },
);
