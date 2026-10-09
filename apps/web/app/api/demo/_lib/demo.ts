// Shared code of the Demo Mode route handlers (/api/demo/*).
//
// Demo Mode is a separate code path from the participant API (spec 3.2, 162).
// A demo session has its own HttpOnly cookie, so a demo on a study laptop never
// replaces or reads the cookie of a research session, and a research session
// token is never accepted here.
import "server-only";
import { cookies } from "next/headers";
import { AppError, demoSchemas, sessionSchemas } from "@dialect/domain";
import { demo, type ServiceContext } from "@dialect/research";
import { getAdminSession, type AdminSession } from "@/lib/server/admin-auth";
import type { ApiRouteOptions } from "@/lib/server/api";
import { getServiceContext } from "@/lib/server/context";
import { getEnv } from "@/lib/server/env";
import { clientAddressKey, consumeRateLimit, rateLimitedError } from "@/lib/server/rate-limit";

export const DEMO_COOKIE_NAME = "dts_demo";

export const DEMO_READ: ApiRouteOptions = { auth: "public" };
// State-changing demo requests must come from the app's own pages.
export const DEMO_WRITE: ApiRouteOptions = { auth: "public", sameOrigin: true };

// Limits per client address for visitors of a public demo (spec 67). A signed-in
// researcher is not limited. Every recording costs three kinds of model calls.
// Every request that can lead to a provider call is counted: a recording takes
// one hit for the upload and one for each pipeline request (three when the page
// runs the stages one after the other, more when a failed stage is tried
// again). 240 hits are about 60 recordings per hour and address.
// Two further limits are enforced by the demo service (packages/research/src/demo/budget.ts):
// three attempts per step of a recording, and the daily budget of the study.
export const DEMO_SESSION_LIMIT = 30;
export const DEMO_RECORDING_LIMIT = 240;
export const DEMO_LIMIT_WINDOW_SECONDS = 3600;

function cookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: getEnv().isProduction, path: "/" };
}

export async function setDemoCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(DEMO_COOKIE_NAME, token, { ...cookieOptions(), expires: expiresAt });
}

export async function readDemoToken(): Promise<string | null> {
  const value = (await cookies()).get(DEMO_COOKIE_NAME)?.value;
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return value;
}

export async function clearDemoCookie(): Promise<void> {
  (await cookies()).set(DEMO_COOKIE_NAME, "", { ...cookieOptions(), maxAge: 0 });
}

export type DemoCaller = {
  admin: AdminSession | null;
  isAdmin: boolean;
  // The service context of the caller: with the admin actor label for a researcher.
  ctx: ServiceContext;
  access: demoSchemas.DemoAccess;
};

// Who is calling, and whether Demo Mode is open to them: a signed-in researcher
// always, anyone else only when the study setting demoPublic is true.
export async function requireDemoCaller(): Promise<DemoCaller> {
  const admin = await getAdminSession();
  const ctx = getServiceContext(admin?.actorLabel ?? null);
  const access = await demo.getDemoAccess(ctx, { isAdmin: admin !== null });
  if (!admin && !access.demoPublic) {
    throw new AppError("UNAUTHORIZED", "Demo Mode is only available to a signed-in researcher on this server.");
  }
  return { admin, isAdmin: admin !== null, ctx, access };
}

// The open demo session of the cookie, or null. A cookie that no longer leads
// to a session is cleared.
export async function findDemoSession(ctx: ServiceContext) {
  const token = await readDemoToken();
  if (!token) return null;
  const session = await demo.findDemoSessionByToken(ctx, token);
  if (!session) await clearDemoCookie();
  return session;
}

export async function requireDemoSession(ctx: ServiceContext) {
  const session = await findDemoSession(ctx);
  if (!session) throw new AppError("SESSION_EXPIRED", "The demo session has ended. Please start again.");
  return session;
}

export async function limitVisitor(
  caller: DemoCaller,
  request: Request,
  bucket: "session" | "recording",
): Promise<void> {
  if (caller.isAdmin) return;
  const result = await consumeRateLimit(caller.ctx.db, {
    bucket: `demo-${bucket}:${clientAddressKey(request)}`,
    limit: bucket === "session" ? DEMO_SESSION_LIMIT : DEMO_RECORDING_LIMIT,
    windowSeconds: DEMO_LIMIT_WINDOW_SECONDS,
    now: caller.ctx.now(),
  });
  if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
}

// Ends the demo session of the cookie. Its data is kept when the study setting
// demoPersist is true, and deleted otherwise (spec 80).
export async function endDemoSession(caller: DemoCaller): Promise<demoSchemas.EndDemoSessionResponse> {
  const session = await findDemoSession(caller.ctx);
  await clearDemoCookie();
  if (!session) return { ended: false, purged: false };
  if (caller.access.demoPersist) {
    await demo.completeDemoSession(caller.ctx, session.id);
    return { ended: true, purged: false };
  }
  await demo.purgeDemoSession(caller.ctx, session.id, { reason: "demo_session_ended" });
  return { ended: true, purged: true };
}

// The JSON text parts of a multipart upload.
export function parseJsonPart<T>(
  value: FormDataEntryValue | null | undefined,
  name: string,
  parse: (raw: unknown) => T,
): T {
  if (value === null || value === undefined) return parse({});
  if (typeof value !== "string") throw new AppError("VALIDATION_ERROR", `The part "${name}" must be JSON text.`);
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new AppError("VALIDATION_ERROR", `The part "${name}" must be valid JSON.`);
  }
  return parse(raw);
}

export function parseCaptureMetadata(value: FormDataEntryValue | null | undefined): sessionSchemas.CaptureMetadata {
  return parseJsonPart(value, "metadata", (raw) => sessionSchemas.captureMetadataSchema.parse(raw));
}

// An upload above the limit is refused by its announced size before anything is
// read. The limit of a demo recording is the upload size of the study settings.
// A pipeline test clip has its own small limit.
export function tooLargeMessage(maxBytes: number): string {
  return `The recording is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB. Record a shorter clip, or choose compressed capture under Options.`;
}
