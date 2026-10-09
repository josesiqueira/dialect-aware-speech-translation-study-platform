// Shared code of the participant route handlers (/api/study/*).
//
// The session is identified only by the HttpOnly cookie. No handler reads a
// session id from the query string or the body (spec 60, 61).
import "server-only";
import { AppError, isAppError } from "@dialect/domain";
import { sessions, type ServiceContext } from "@dialect/research";
import { readLimitedBody, type ApiRouteOptions } from "@/lib/server/api";
import { parseMultipart, type MultipartBody } from "@/lib/server/multipart";
import { clearParticipantCookie, readParticipantToken } from "@/lib/server/participant-cookie";

// Options for handlers that only read.
export const PUBLIC_READ: ApiRouteOptions = { auth: "public" };
// Options for handlers that change state: the request must come from the app's
// own pages (same-origin check, see assertSameOrigin in lib/server/api.ts).
export const PUBLIC_WRITE: ApiRouteOptions = { auth: "public", sameOrigin: true };

// Session creation limit per client address (spec 67). One shared study laptop
// runs many participants in a day, so the limit is generous: 120 new sessions
// per hour. Without TRUST_PROXY every client shares one bucket, and one client
// can then use up the limit for everyone: the server warns about that
// configuration at startup and in GET /api/health/ready (see
// configurationWarnings in lib/server/env.ts).
//
// Largest JSON body of the questionnaire route: up to 500 answers, some of them
// free text. Every other participant route uses the 64 KB default.
export const QUESTIONNAIRE_BODY_LIMIT_BYTES = 256 * 1024;
export const SESSION_CREATE_LIMIT = 120;
export const SESSION_CREATE_WINDOW_SECONDS = 3600;

// The session of the cookie. Throws SESSION_EXPIRED (401) without a usable session.
export async function requireParticipantSession(ctx: ServiceContext): Promise<sessions.SessionRow> {
  const token = await readParticipantToken();
  return sessions.getSessionByToken(ctx, token);
}

// The session of the cookie, or null. A cookie that no longer leads to a session is cleared.
export async function findParticipantSession(ctx: ServiceContext): Promise<sessions.SessionRow | null> {
  const token = await readParticipantToken();
  if (!token) return null;
  try {
    return await sessions.getSessionByToken(ctx, token);
  } catch (error) {
    if (isAppError(error) && error.code === "SESSION_EXPIRED") {
      await clearParticipantCookie();
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Upload body
// ---------------------------------------------------------------------------

// Room for the multipart boundaries, part headers and the metadata part.
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function tooLarge(maxBytes: number): AppError {
  return new AppError("PAYLOAD_TOO_LARGE", "The recording is larger than the allowed size.", {
    reason: "too_large",
    maxBytes,
  });
}

// Reads a multipart/form-data request while counting its bytes, and stops as soon
// as the body is larger than the limit. The body is read once: the counted stream
// is handed to the platform's multipart parser.
export async function readLimitedFormData(request: Request, maxFileBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new AppError("VALIDATION_ERROR", "The upload must be sent as multipart/form-data.");
  }
  const maxBodyBytes = maxFileBytes + MULTIPART_OVERHEAD_BYTES;
  // First check: the size the client announces. Nothing has been read yet.
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) throw tooLarge(maxFileBytes);
  if (!request.body) throw new AppError("VALIDATION_ERROR", "The upload is empty.");

  // Second check: the bytes that really arrive (the header can be missing or wrong).
  let received = 0;
  let exceeded = false;
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBodyBytes) {
          exceeded = true;
          controller.error(new Error("upload too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: counted,
      duplex: "half",
    } as RequestInit & { duplex: "half" }).formData();
  } catch {
    if (exceeded) throw tooLarge(maxFileBytes);
    throw new AppError("VALIDATION_ERROR", "The upload could not be read. Please try again.");
  }
}

// Reads a multipart/form-data upload into one buffer (counted, at most the file
// limit plus the multipart overhead) and returns its parts. A file part is a
// view of that buffer, so the recording is held in memory once. Use this
// instead of readLimitedFormData for audio uploads (see lib/server/multipart.ts).
export async function readLimitedMultipart(request: Request, maxFileBytes: number): Promise<MultipartBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new AppError("VALIDATION_ERROR", "The upload must be sent as multipart/form-data.");
  }
  let body: Buffer;
  try {
    body = await readLimitedBody(request, maxFileBytes + MULTIPART_OVERHEAD_BYTES);
  } catch (error) {
    if (isAppError(error) && error.code === "PAYLOAD_TOO_LARGE") throw tooLarge(maxFileBytes);
    throw new AppError("VALIDATION_ERROR", "The upload could not be read. Please try again.");
  }
  if (body.length === 0) throw new AppError("VALIDATION_ERROR", "The upload is empty.");
  return parseMultipart(body, contentType);
}
