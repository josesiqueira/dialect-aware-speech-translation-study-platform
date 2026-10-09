// POST /api/study/sessions: start a session, or resume the one of the cookie.
// Body: CreateSessionBody. Response: CreateSessionResponse.
//
// - A valid cookie for a session that has not ended: that session's state is
//   returned and nothing is created (a page reload must not start a new session).
// - restart: true (study laptop, "Start next participant"): the old cookie is
//   dropped and a new session is created.
// - mode "test" needs a signed-in admin. mode "demo" needs one too, unless the
//   study setting demoPublic is true. Otherwise 403 FORBIDDEN.
import { sessionSchemas } from "@dialect/domain";
import { sessions } from "@dialect/research";
import { getAdminSession } from "@/lib/server/admin-auth";
import { apiRoute, jsonOk, parseJsonBody } from "@/lib/server/api";
import { clearParticipantCookie, readParticipantToken, setParticipantCookie } from "@/lib/server/participant-cookie";
import { clientAddressKey, consumeRateLimit, purgeOldHits, rateLimitedError } from "@/lib/server/rate-limit";
import {
  findParticipantSession,
  PUBLIC_WRITE,
  SESSION_CREATE_LIMIT,
  SESSION_CREATE_WINDOW_SECONDS,
} from "../_lib/participant";

const TERMINAL = new Set(["completed", "withdrawn", "abandoned"]);

export const POST = apiRoute(
  async (request, { ctx }) => {
    const body = await parseJsonBody(request, sessionSchemas.createSessionBodySchema);

    if (!body.restart) {
      const existing = await findParticipantSession(ctx);
      if (existing && !TERMINAL.has(existing.status)) {
        const response: sessionSchemas.CreateSessionResponse = {
          state: await sessions.getParticipantState(ctx, existing),
          resumed: true,
        };
        return jsonOk(response);
      }
    }
    if (await readParticipantToken()) await clearParticipantCookie();

    const now = ctx.now();
    const limit = await consumeRateLimit(ctx.db, {
      bucket: `session-create:${clientAddressKey(request)}`,
      limit: SESSION_CREATE_LIMIT,
      windowSeconds: SESSION_CREATE_WINDOW_SECONDS,
      now,
    });
    if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
    await purgeOldHits(ctx.db, { now });

    const admin = await getAdminSession();
    const created = await sessions.createSession(ctx, {
      mode: body.mode ?? "research",
      locale: body.locale ?? null,
      browserInfo: body.browserInfo ?? null,
      callerIsAdmin: admin !== null,
    });
    await setParticipantCookie(created.token, created.tokenExpiresAt);
    const response: sessionSchemas.CreateSessionResponse = { state: created.state, resumed: false };
    return jsonOk(response);
  },
  { ...PUBLIC_WRITE, route: "/api/study/sessions" },
);
