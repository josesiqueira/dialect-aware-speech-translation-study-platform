// GET /api/study/info: what the welcome page needs. No session required.
// Response: StudyInfoResponse (docs/PARTICIPANT-API.md).
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { PUBLIC_READ } from "../_lib/participant";

export const GET = apiRoute(async (_request, { ctx }) => jsonOk(await sessions.getPublicStudyInfo(ctx)), {
  ...PUBLIC_READ,
  route: "/api/study/info",
});
