// POST /api/demo/recordings/:id/run: run the pipeline on one stored demo
// recording, in this request (spec 80, 163).
//
// Body: { stage?: "all" | "asr" | "translation" | "tts", provider?: "active" | "mock" }.
// Response: { result: DemoResult }. A failed stage is part of the result with
// status 200: the transcript is still returned when a translation fails. Only
// a missing session or recording is an error response, and 429 RATE_LIMITED
// when the visitor's hourly limit or the daily demo budget of the study
// (details.reason "demo_daily_budget") is used up.
//
// "mock" runs the stored mock provider configurations instead of the active
// ones. It is refused unless the caller is a signed-in researcher and the mock
// provider is allowed on this server.
import { AppError, demoSchemas } from "@dialect/domain";
import { demo } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { DEMO_WRITE, limitVisitor, requireDemoCaller, requireDemoSession } from "../../../_lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Model calls can take longer than the default time limit of some hosts.
export const maxDuration = 300;

export const POST = apiRoute<{ id: string }>(
  async (request, { params }) => {
    const { id } = demoSchemas.mediaIdParamSchema.parse(params);
    const caller = await requireDemoCaller();
    const session = await requireDemoSession(caller.ctx);
    const body = await parseJsonBody(request, demoSchemas.runDemoRecordingBodySchema);
    const stage = body.stage ?? "all";
    // Every stage request of a visitor is counted. A stage that failed can be
    // requested again and every attempt is a paid provider call, so no stage is
    // free of the limit. The demo service adds two further limits: three
    // attempts per step of a recording, and the daily budget of the study.
    await limitVisitor(caller, request, "recording");

    const useMock = body.provider === "mock";
    if (useMock && !caller.access.mockAvailable) {
      throw new AppError(
        "FORBIDDEN",
        "The mock provider option is only available to a signed-in researcher on a server that allows the mock provider.",
      );
    }
    const result = await demo.runDemoPipeline(caller.ctx, {
      sessionId: session.id,
      utteranceId: id,
      stage,
      configs: useMock ? { kind: "mock" } : { kind: "active" },
      isAdmin: caller.isAdmin,
    });
    const response: demoSchemas.RunDemoRecordingResponse = { result };
    return jsonOk(response);
  },
  { ...DEMO_WRITE, route: "/api/demo/recordings/[id]/run" },
);
