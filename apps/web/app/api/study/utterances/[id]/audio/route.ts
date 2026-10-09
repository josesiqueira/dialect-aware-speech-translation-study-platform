// POST   /api/study/utterances/:id/audio: upload the recording of an utterance.
// DELETE /api/study/utterances/:id/audio: remove an uploaded recording that was not submitted.
//
// POST body: multipart/form-data with
//   audio     the file (WAV, or WebM, Ogg or MP4 as the compressed fallback)
//   metadata  optional JSON text, CaptureMetadata
// Response: UploadAudioResponse. A new upload for the same utterance replaces the
// earlier one, so a retry after a failure is safe.
//
// Large bodies: proxy.ts does not match /api/study (see its matcher), so Next.js
// does not buffer or cut the body before this handler. The handler checks
// Content-Length first and then counts the bytes while reading them into one
// buffer. The file part is a view of that buffer (lib/server/multipart.ts), so
// the recording is held in memory once. One upload runs at a time per session
// (lib/server/upload-guard.ts): a second concurrent upload gets 409 CONFLICT.
import { sessionSchemas, AppError } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { apiRoute, jsonOk } from "@/lib/server/api";
import { withSingleUpload } from "@/lib/server/upload-guard";
import { PUBLIC_WRITE, readLimitedMultipart, requireParticipantSession } from "../../../_lib/participant";

// Uploads run in the Node.js runtime and are never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseMetadata(value: string | undefined): sessionSchemas.CaptureMetadata {
  if (value === undefined) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new AppError("VALIDATION_ERROR", "The metadata part must be valid JSON.");
  }
  return sessionSchemas.captureMetadataSchema.parse(raw);
}

export const POST = apiRoute<{ id: string }>(
  async (request, { ctx, params }) => {
    const { id } = sessionSchemas.idParamSchema.parse(params);
    // The session is resolved before a single byte of the body is read.
    const session = await requireParticipantSession(ctx);
    const limits = await sessions.getSessionLimits(ctx, session);

    // One upload at a time per session: a second one gets 409 before its body is read.
    return withSingleUpload(`study:${session.id}`, async () => {
      const parts = await readLimitedMultipart(request, limits.maxUploadBytes);
      const file = parts.files.get("audio");
      if (!file) throw new AppError("VALIDATION_ERROR", "The upload must contain the file part \"audio\".");
      if (parts.files.has("metadata")) throw new AppError("VALIDATION_ERROR", "The metadata part must be JSON text.");
      const metadata = parseMetadata(parts.fields.get("metadata"));
      const userAgent = metadata.userAgent ?? request.headers.get("user-agent")?.slice(0, 500);

      const response: sessionSchemas.UploadAudioResponse = await sessions.uploadUtteranceAudio(ctx, session, {
        utteranceId: id,
        // A view of the request body buffer: the recording is in memory once.
        data: file.data,
        declaredMimeType: file.type || null,
        captureMetadata: { ...metadata, ...(userAgent ? { userAgent } : {}) },
      });
      return jsonOk(response);
    });
  },
  { ...PUBLIC_WRITE, route: "/api/study/utterances/[id]/audio" },
);

export const DELETE = apiRoute<{ id: string }>(
  async (_request, { ctx, params }) => {
    const { id } = sessionSchemas.idParamSchema.parse(params);
    const session = await requireParticipantSession(ctx);
    const response: sessionSchemas.StateResponse = {
      state: await sessions.discardCandidate(ctx, session, { utteranceId: id }),
    };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/utterances/[id]/audio" },
);
