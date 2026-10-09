// Wrapper and helpers for every API route handler.
//
// USAGE
//
// Admin route, app/api/admin/sessions/[id]/flag/route.ts:
//
//   import { z } from "zod";
//   import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
//   import { flagSession } from "@dialect/research";
//
//   const bodySchema = z.object({ flagged: z.boolean(), reason: z.string().max(500).optional() });
//
//   export const PATCH = apiRoute<{ id: string }>(
//     async (request, { params, ctx }) => {
//       const body = await parseJsonBody(request, bodySchema);
//       const session = await flagSession(ctx, { sessionId: params.id, ...body });
//       return jsonOk({ session });
//     },
//     { auth: "admin" },
//   );
//
// Public (participant) route, app/api/study/consent/route.ts:
//
//   export const POST = apiRoute(
//     async (request, { ctx }) => {
//       const body = await parseJsonBody(request, consentSchema);
//       const token = await readParticipantToken();
//       return jsonOk(await recordConsent(ctx, { token, ...body }));
//     },
//     { auth: "public" },
//   );
//
// What apiRoute does for you:
// - creates a request id and returns it in the `x-request-id` header;
// - with auth "admin": verifies the admin session cookie itself (it does not rely on
//   proxy.ts), rejects cross-origin state-changing requests, forces
//   `Cache-Control: no-store, private`, and builds `ctx` with the admin actor label;
// - with auth "public": no session check, `ctx.actorLabel` is null, `Cache-Control: no-store`
//   unless the handler set its own value;
// - awaits the Promise-based `params` of Next.js 16 and passes the resolved object;
// - sets the size limit that parseJsonBody applies: 64 KB on a public route,
//   1 MB on an admin route (after the session was verified);
// - turns thrown errors into the standard body { error: { code, message, details? } }:
//     AppError                         its code and httpStatus
//     ZodError                         VALIDATION_ERROR 400, details.issues = [{ path, message }]
//     PostgreSQL IMMUTABLE_RECORD      IMMUTABLE_RECORD 409 (immutability triggers)
//     PostgreSQL INVALID_STATE         INVALID_STATE 409 (state triggers)
//     PostgreSQL unique violation      CONFLICT 409
//     anything else                    INTERNAL_ERROR 500, generic message, nothing leaked
// - logs request id, method, route, status and duration. It never logs bodies.
//
// Rules for handlers: on a route that needs a session, resolve the session
// before reading the body, so an anonymous request costs no body read; throw AppError (or let a service throw it) instead of building
// error responses by hand; validate every input with parseJsonBody, parseQuery or
// getRouteParams; never log request bodies, transcripts or consent answers (spec 68).
import "server-only";
import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { AppError, httpStatusOf, isAppError, type ApiErrorBody, type ErrorCode } from "@dialect/domain";
import type { ServiceContext } from "@dialect/research";
import { requireAdmin, type AdminSession } from "./admin-auth";
import { getLogger, getServiceContext } from "./context";
import { getEnv } from "./env";

export type RouteContext<P = Record<string, never>> = { params: Promise<P> };

export type ApiRouteOptions = {
  // "admin": a valid admin session is required. "public": no session check.
  auth: "admin" | "public";
  // Same-origin check (CSRF protection). Default: on for state-changing admin
  // requests, off for public routes. Set true on a public route that changes
  // state based on a cookie (login and logout do).
  sameOrigin?: boolean;
  // Route label for the log, for example "/api/admin/sessions/[id]". Default: the request path.
  route?: string;
};

export type ApiHandlerArgs<P> = {
  // Resolved dynamic route parameters.
  params: P;
  // Service context for calling @dialect/research functions.
  ctx: ServiceContext;
  requestId: string;
  // "admin" on admin routes, null on public routes.
  actorLabel: string | null;
  // The verified admin session on admin routes, null on public routes.
  session: AdminSession | null;
};

export type ApiHandler<P> = (request: Request, args: ApiHandlerArgs<P>) => Promise<Response> | Response;

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function apiRoute<P = Record<string, never>>(
  handler: ApiHandler<P>,
  options: ApiRouteOptions,
): (request: Request, context: RouteContext<P>) => Promise<Response> {
  return async (request, context) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const method = request.method.toUpperCase();
    const route = options.route ?? safePathname(request);
    let response: Response;
    let failure: unknown = null;

    try {
      const checkOrigin =
        options.sameOrigin ?? (options.auth === "admin" && STATE_CHANGING_METHODS.has(method));
      if (checkOrigin && STATE_CHANGING_METHODS.has(method)) assertSameOrigin(request);

      const session = options.auth === "admin" ? await requireAdmin() : null;
      if (session) jsonBodyLimits.set(request, ADMIN_JSON_BODY_LIMIT_BYTES);
      const actorLabel = session?.actorLabel ?? null;
      const params = ((await context?.params) ?? {}) as P;
      const ctx = getServiceContext(actorLabel);
      response = await handler(request, { params, ctx, requestId, actorLabel, session });
    } catch (error) {
      // redirect() and notFound() work by throwing: let Next.js handle those.
      unstable_rethrow(error);
      failure = error;
      response = errorResponse(error);
    }

    response = withHeaders(response, (headers) => {
      headers.set("x-request-id", requestId);
      if (options.auth === "admin") headers.set("Cache-Control", "no-store, private");
      else if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
    });

    logRequest({ requestId, method, route, status: response.status, startedAt, failure });
    return response;
  };
}

// ---------------------------------------------------------------------------
// Helpers for handlers
// ---------------------------------------------------------------------------

export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, { status: 200, ...init });
}

// Largest JSON body of a public route (participant API, Demo Mode, login). The
// requests of the participant flow are a few hundred bytes. A route that needs
// more passes `maxBytes` (the questionnaire route does, for free text answers).
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 64 * 1024;
// Largest JSON body of an admin route: protocol, consent and questionnaire texts
// can be long, and the caller is a signed-in researcher.
export const ADMIN_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

// The default limit of the request, set by apiRoute from the route's auth option.
const jsonBodyLimits = new WeakMap<Request, number>();

function bodyTooLarge(maxBytes: number): AppError {
  return new AppError("PAYLOAD_TOO_LARGE", "The request body is larger than the allowed size.", {
    reason: "too_large",
    maxBytes,
  });
}

// Reads a request body while counting its bytes and stops as soon as it is
// larger than `maxBytes` (413 PAYLOAD_TOO_LARGE). The announced Content-Length is
// checked first, before anything is read. The bytes are held once: with a
// Content-Length the buffer is allocated once and filled in place.
export async function readLimitedBody(request: Request, maxBytes: number): Promise<Buffer> {
  const header = request.headers.get("content-length");
  const declared = header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
  if (declared !== null && declared > maxBytes) throw bodyTooLarge(maxBytes);
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  let received = 0;
  const overflow = async (): Promise<never> => {
    await reader.cancel().catch(() => {});
    throw bodyTooLarge(maxBytes);
  };

  if (declared !== null) {
    const buffer = Buffer.allocUnsafe(declared);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // More bytes than announced: the header was wrong. The limit still holds.
      if (received + value.byteLength > declared) {
        if (received + value.byteLength > maxBytes) return overflow();
        const grown = Buffer.concat([buffer.subarray(0, received), value]);
        received = grown.length;
        return readRest(reader, [grown], received, maxBytes);
      }
      buffer.set(value, received);
      received += value.byteLength;
    }
    return buffer.subarray(0, received);
  }
  return readRest(reader, [], 0, maxBytes);
}

async function readRest(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
  alreadyReceived: number,
  maxBytes: number,
): Promise<Buffer> {
  let received = alreadyReceived;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw bodyTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return chunks.length === 1 ? Buffer.from(chunks[0]!.buffer, chunks[0]!.byteOffset, chunks[0]!.byteLength) : Buffer.concat(chunks);
}

// Reads and validates a JSON body. The body is read through a counted stream:
// at most `maxBytes` (default 64 KB on public routes, 1 MB on admin routes),
// otherwise 413 PAYLOAD_TOO_LARGE. Throws VALIDATION_ERROR for malformed JSON
// and a ZodError (mapped to VALIDATION_ERROR by apiRoute) for a wrong shape.
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  options: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const maxBytes = options.maxBytes ?? jsonBodyLimits.get(request) ?? DEFAULT_JSON_BODY_LIMIT_BYTES;
  const bytes = await readLimitedBody(request, maxBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AppError("VALIDATION_ERROR", "The request body must be valid JSON.");
  }
  return schema.parse(raw);
}

// Validates the query string. A parameter given once is a string, a repeated
// parameter is an array of strings.
export function parseQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return schema.parse(query);
}

// Resolves the Promise-based params of Next.js 16, optionally validating them.
// apiRoute already passes resolved params; this is for handlers written without it.
export async function getRouteParams<P>(context: RouteContext<P>): Promise<P>;
export async function getRouteParams<S extends z.ZodType>(
  context: RouteContext<unknown>,
  schema: S,
): Promise<z.output<S>>;
export async function getRouteParams(context: RouteContext<unknown>, schema?: z.ZodType): Promise<unknown> {
  const params = await context.params;
  return schema ? schema.parse(params) : params;
}

// ---------------------------------------------------------------------------
// Same-origin check
// ---------------------------------------------------------------------------

// Rejects a request that a browser sent from another origin. Browsers attach
// `Sec-Fetch-Site` (secure contexts) and `Origin` (every state-changing fetch and
// form post) and page scripts cannot change them. A request with neither header
// is rejected too, so a command line client must send `Origin: <APP_URL>`.
export function assertSameOrigin(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) {
    if (fetchSite.toLowerCase() === "same-origin") return;
    throw new AppError("FORBIDDEN", "Cross-origin requests are not allowed.");
  }
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins(request).has(origin.toLowerCase())) return;
  throw new AppError("FORBIDDEN", "Cross-origin requests are not allowed.");
}

function allowedOrigins(request: Request): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(getEnv().APP_URL).origin.toLowerCase());
  } catch {
    // An invalid configuration is reported by getEnv() elsewhere.
  }
  try {
    origins.add(new URL(request.url).origin.toLowerCase());
  } catch {
    // Not a parseable URL: only APP_URL is allowed.
  }
  return origins;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

type PgLikeError = { code?: unknown; message?: unknown; constraint?: unknown };

// Drizzle wraps driver errors, so the PostgreSQL error may be a `cause`.
function findInCauses<T>(error: unknown, pick: (candidate: PgLikeError) => T | null): T | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const found = pick(current as PgLikeError);
    if (found) return found;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

// Converts any thrown value to an AppError with a message that is safe to return.
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof z.ZodError) {
    return new AppError("VALIDATION_ERROR", "The request is not valid.", {
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  const database = findInCauses(error, (candidate): AppError | null => {
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (candidate.code === "IMMUT" || message.startsWith("IMMUTABLE_RECORD")) {
      return new AppError(
        "IMMUTABLE_RECORD",
        "This record is published or stored and can no longer be changed. Create a new version instead.",
        { reason: triggerReason(message, "IMMUTABLE_RECORD") },
      );
    }
    if (candidate.code === "INVST" || message.startsWith("INVALID_STATE")) {
      return new AppError("INVALID_STATE", "The record is not in a state that allows this change.", {
        reason: triggerReason(message, "INVALID_STATE"),
      });
    }
    if (candidate.code === "23505") {
      return new AppError(
        "CONFLICT",
        "A record with the same unique value already exists.",
        typeof candidate.constraint === "string" ? { constraint: candidate.constraint } : undefined,
      );
    }
    return null;
  });
  if (database) return database;

  return new AppError("INTERNAL_ERROR", "Something went wrong on the server. Please try again.");
}

// "IMMUTABLE_RECORD: protocol_versions: published" gives "protocol_versions: published".
// The text comes from our own triggers, never from user input or a provider.
function triggerReason(message: string, prefix: string): string | undefined {
  if (!message.startsWith(prefix)) return undefined;
  const reason = message.slice(prefix.length).replace(/^:\s*/, "").trim();
  return reason || undefined;
}

export function errorResponse(error: unknown): Response {
  const appError = toAppError(error);
  const body: ApiErrorBody = {
    error: {
      code: appError.code as ErrorCode,
      message: appError.message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
  };
  const headers = new Headers();
  if (appError.code === "RATE_LIMITED") {
    const retryAfter = (appError.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    if (typeof retryAfter === "number") headers.set("Retry-After", String(retryAfter));
  }
  return Response.json(body, { status: httpStatusOf(appError), headers });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function safePathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "unknown";
  }
}

// Some responses have immutable headers (for example Response.redirect()).
function withHeaders(response: Response, apply: (headers: Headers) => void): Response {
  try {
    apply(response.headers);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    apply(headers);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

function logRequest(entry: {
  requestId: string;
  method: string;
  route: string;
  status: number;
  startedAt: number;
  failure: unknown;
}): void {
  try {
    const logger = getLogger();
    const fields: Record<string, unknown> = {
      requestId: entry.requestId,
      method: entry.method,
      route: entry.route,
      status: entry.status,
      durationMs: Date.now() - entry.startedAt,
    };
    if (entry.failure !== null) {
      const appError = isAppError(entry.failure) ? entry.failure : null;
      fields.errorCode = appError?.code ?? toAppError(entry.failure).code;
      if (entry.status >= 500) {
        // Server-side only: the cause chain helps debugging and never reaches the client.
        // Not under the key `err`: pino's serializer for that key would rebuild the
        // message from the cause chain and undo the filtering in describeError().
        fields.error = describeError(entry.failure);
        logger.error(fields, "request failed");
        return;
      }
    }
    logger.info(fields, "request");
  } catch {
    // Logging must never break a response.
  }
}

function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const fields = error as Error & {
    code?: unknown;
    severity?: unknown;
    constraint?: unknown;
    table?: unknown;
    column?: unknown;
  };
  // Database error messages can contain row values: a Drizzle query error lists the
  // SQL parameters, and PostgreSQL quotes the rejected value. Those values can be
  // transcript text or questionnaire answers, so a fixed message plus the SQLSTATE
  // and the object names is logged instead (spec 68).
  const isQueryError = error.name === "DrizzleQueryError" || error.message.startsWith("Failed query");
  const isPostgresError = typeof fields.severity === "string" && typeof fields.code === "string";
  const described: Record<string, unknown> = {
    name: error.name,
    message: isQueryError ? "database query failed" : isPostgresError ? "database error" : error.message,
  };
  if (typeof fields.code === "string") described.code = fields.code;
  if (isPostgresError) {
    for (const key of ["constraint", "table", "column"] as const) {
      if (typeof fields[key] === "string") described[key] = fields[key];
    }
  }
  if (depth === 0 && error.stack) {
    // Stack frames only: the first lines of `stack` repeat the message.
    described.stack = error.stack
      .split("\n")
      .filter((line) => line.trimStart().startsWith("at "))
      .join("\n");
  }
  if (error.cause !== undefined && depth < 3) described.cause = describeError(error.cause, depth + 1);
  return described;
}
