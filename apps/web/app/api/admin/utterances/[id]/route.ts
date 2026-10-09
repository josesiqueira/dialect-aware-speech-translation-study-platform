// GET /api/admin/utterances/:id (spec 46, 60). Everything the review screen
// shows for one utterance: session, task, exact prompt, source media metadata,
// the four transcripts, difference annotations, flags and notes.
import { transcripts } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";

export const GET = apiRoute<{ id: string }>(
  async (_request, { params, ctx }) => jsonOk(await transcripts.getUtteranceForReview(ctx, params.id)),
  { auth: "admin", route: "/api/admin/utterances/[id]" },
);
