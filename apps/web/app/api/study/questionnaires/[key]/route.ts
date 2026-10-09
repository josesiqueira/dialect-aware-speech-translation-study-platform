// POST /api/study/questionnaires/:key (key: background or post_recording).
// Body: QuestionnaireBody. Response: StateResponse.
// 400 VALIDATION_ERROR with details.issues = [{ path: itemKey, message }].
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { PUBLIC_WRITE, QUESTIONNAIRE_BODY_LIMIT_BYTES, requireParticipantSession } from "../../_lib/participant";

export const POST = apiRoute<{ key: string }>(
  async (request, { ctx, params }) => {
    const { key } = sessionSchemas.questionnaireParamSchema.parse(params);
    const session = await requireParticipantSession(ctx);
    // Free text answers can be long: this route allows 256 KB instead of 64 KB.
    const body = await parseJsonBody(request, sessionSchemas.questionnaireBodySchema, {
      maxBytes: QUESTIONNAIRE_BODY_LIMIT_BYTES,
    });
    const response: sessionSchemas.StateResponse = {
      state: await sessions.submitQuestionnaire(ctx, session, { key, answers: body.answers }),
    };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/questionnaires/[key]" },
);
