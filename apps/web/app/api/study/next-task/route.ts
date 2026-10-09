// GET /api/study/next-task (spec 60): the current task of the cookie's session.
// Response: NextTaskResponse. `task` is null when the session is not at the task step.
// The same information is part of every ParticipantState.
import type { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { PUBLIC_READ, requireParticipantSession } from "../_lib/participant";

export const GET = apiRoute(
  async (_request, { ctx }) => {
    const session = await requireParticipantSession(ctx);
    const state = await sessions.getParticipantState(ctx, session);
    const response: sessionSchemas.NextTaskResponse = {
      step: state.step,
      progress: state.progress,
      task: state.step === "tasks" ? state.task : null,
    };
    return jsonOk(response);
  },
  { ...PUBLIC_READ, route: "/api/study/next-task" },
);
