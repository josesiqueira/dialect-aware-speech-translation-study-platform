// GET  /api/admin/ai/test: the result of the latest pipeline test, and whether
//      the mock option is available.
// POST /api/admin/ai/test: run the pipeline smoke test (spec 52): storage write,
//      ASR, default translation, preservation translation and TTS, each PASS or
//      FAIL. Everything it creates has mode `test`.
//
// POST body, one of:
//   JSON                 { source: "generated_tone", provider?: "active" | "mock" }
//   multipart/form-data  audio (the recorded clip), metadata? (CaptureMetadata as
//                        JSON text), options? ({ provider? } as JSON text)
// Response: { result: PipelineTestResult }. A failing stage is a FAIL row with
// status 200. An unusable recording is an error response.
//
// A test clip is at most 30 seconds and 9 MB, and a larger upload is refused by
// its size. The route is left out of the proxy matcher (proxy.ts), because
// Next.js cuts the body of a matched request at 10 MB. The admin session is
// verified here by apiRoute({ auth: "admin" }), next to the data.
import { AppError, demoSchemas, isAppError } from "@dialect/domain";
import { aiConfig, demo } from "@dialect/research";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { parseCaptureMetadata, parseJsonPart, tooLargeMessage } from "../../../demo/_lib/demo";
import { readLimitedFormData } from "../../../study/_lib/participant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = apiRoute(
  async (_request, { ctx }) => {
    const study = await aiConfig.resolveStudy(ctx);
    const response: demoSchemas.LastPipelineTestResponse = {
      last: await demo.getLastPipelineTest(ctx),
      mockAvailable: demo.mockProviderAvailable(ctx),
      timeZone: study.settingsJson.adminTimezone ?? "UTC",
    };
    return jsonOk(response);
  },
  { auth: "admin", route: "/api/admin/ai/test" },
);

export const POST = apiRoute(
  async (request, { ctx }) => {
    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
    let input: demo.RunPipelineTestInput;
    if (contentType.startsWith("multipart/form-data")) {
      let form: FormData;
      try {
        form = await readLimitedFormData(request, demoSchemas.PIPELINE_TEST_MAX_UPLOAD_BYTES);
      } catch (error) {
        if (isAppError(error) && error.code === "PAYLOAD_TOO_LARGE") {
          throw new AppError("PAYLOAD_TOO_LARGE", tooLargeMessage(demoSchemas.PIPELINE_TEST_MAX_UPLOAD_BYTES), error.details);
        }
        throw error;
      }
      const file = form.get("audio");
      if (file === null || typeof file === "string") {
        throw new AppError("VALIDATION_ERROR", 'The upload must contain the file part "audio".');
      }
      const options = parseJsonPart(form.get("options"), "options", (raw) =>
        demoSchemas.pipelineTestOptionsSchema.parse(raw),
      );
      input = {
        audio: {
          kind: "recording",
          data: Buffer.from(await file.arrayBuffer()),
          declaredMimeType: file.type || null,
          captureMetadata: parseCaptureMetadata(form.get("metadata")),
        },
        provider: options.provider ?? "active",
      };
    } else {
      const body = await parseJsonBody(request, demoSchemas.pipelineTestBodySchema);
      input = { audio: { kind: "generated_tone" }, provider: body.provider ?? "active" };
    }
    const response: demoSchemas.PipelineTestResponse = { result: await demo.runPipelineTest(ctx, input) };
    return jsonOk(response);
  },
  { auth: "admin", route: "/api/admin/ai/test" },
);
