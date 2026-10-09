// GET /api/admin/sessions (spec 43, 60, 134).
// Query: page, pageSize (default 50), sort (started_at, completed_at,
// participant_code, status, utterance_count, audio_duration), direction, search
// (participant code or session id), dateFrom, dateTo (YYYY-MM-DD in the admin
// time zone), protocolVersionId, mode, completion (completed, incomplete),
// flagged, hasProcessingErrors, review (complete, incomplete), excluded.
import { corpusSchemas } from "@dialect/domain";
import { corpus } from "@dialect/research";
import { apiRoute, jsonOk, parseQuery } from "@/lib/server/api";

export const GET = apiRoute(
  async (request, { ctx }) => {
    const { page, pageSize, sort, direction, ...filters } = parseQuery(request, corpusSchemas.sessionListQuerySchema);
    return jsonOk(await corpus.listSessions(ctx, filters, { page, pageSize, sort, direction }));
  },
  { auth: "admin", route: "/api/admin/sessions" },
);
