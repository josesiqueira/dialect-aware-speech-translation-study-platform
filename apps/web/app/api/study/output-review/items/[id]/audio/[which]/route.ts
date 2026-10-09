// GET /api/study/output-review/items/:id/audio/:which (which: source): streams
// the participant's own recording of the current review screen, with HTTP Range
// support. Only to the participant whose session owns the review item and only
// while the review is running. Every other request gives 404. There is no public
// address of any recording.
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute } from "@/lib/server/api";
import { streamMedia } from "../../../../../../admin/media/_lib/stream";
import { PUBLIC_READ, requireParticipantSession } from "../../../../../_lib/participant";

export const dynamic = "force-dynamic";

export const GET = apiRoute<{ id: string; which: string }>(
  async (request, { ctx, params }) => {
    const { id, which } = sessionSchemas.outputReviewAudioParamSchema.parse(params);
    const session = await requireParticipantSession(ctx);
    const asset = await sessions.participantReviewAudio(ctx, session, id, which);
    return streamMedia(ctx, request, asset);
  },
  { ...PUBLIC_READ, route: "/api/study/output-review/items/[id]/audio/[which]" },
);
