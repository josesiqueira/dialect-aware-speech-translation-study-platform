// POST /api/demo/recordings: store one demo recording (spec 31.2, 80).
//
// Body: multipart/form-data with
//   audio     the file (lossless WAV, or WebM, Ogg or MP4 as the compressed capture)
//   metadata  optional JSON text, CaptureMetadata
// Response: { recording: { utteranceId, turnIndex, source } }.
// The pipeline is then run with POST /api/demo/recordings/:id/run.
//
// The recording is validated from its bytes, hashed and stored like research
// audio, in a session whose mode is `demo`. The session is the one of the demo
// cookie: no id is read from the request.
import { AppError, isAppError, type demoSchemas } from "@dialect/domain";
import { demo } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import type { MultipartBody } from "@/lib/server/multipart";
import { withSingleUpload } from "@/lib/server/upload-guard";
import { readLimitedMultipart } from "../../study/_lib/participant";
import {
  DEMO_WRITE,
  limitVisitor,
  parseCaptureMetadata,
  requireDemoCaller,
  requireDemoSession,
  tooLargeMessage,
} from "../_lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = apiRoute(
  async (request) => {
    const caller = await requireDemoCaller();
    const session = await requireDemoSession(caller.ctx);
    await limitVisitor(caller, request, "recording");

    // One upload at a time per demo session: a second one gets 409 before its body is read.
    return withSingleUpload(`demo:${session.id}`, async () => {
      let parts: MultipartBody;
      try {
        parts = await readLimitedMultipart(request, caller.access.maxUploadBytes);
      } catch (error) {
        if (isAppError(error) && error.code === "PAYLOAD_TOO_LARGE") {
          throw new AppError("PAYLOAD_TOO_LARGE", tooLargeMessage(caller.access.maxUploadBytes), error.details);
        }
        throw error;
      }
      const file = parts.files.get("audio");
      if (!file) throw new AppError("VALIDATION_ERROR", 'The upload must contain the file part "audio".');
      if (parts.files.has("metadata")) throw new AppError("VALIDATION_ERROR", 'The part "metadata" must be JSON text.');
      const metadata = parseCaptureMetadata(parts.fields.get("metadata"));
      const userAgent = metadata.userAgent ?? request.headers.get("user-agent")?.slice(0, 500);

      const stored = await demo.createDemoUtterance(caller.ctx, session, {
        // A view of the request body buffer: the recording is in memory once.
        data: file.data,
        declaredMimeType: file.type || null,
        captureMetadata: { ...metadata, ...(userAgent ? { userAgent } : {}) },
      });
      const response: demoSchemas.DemoRecordingResponse = {
        recording: { utteranceId: stored.utteranceId, turnIndex: stored.turnIndex, source: stored.source },
      };
      return jsonOk(response);
    });
  },
  { ...DEMO_WRITE, route: "/api/demo/recordings" },
);
