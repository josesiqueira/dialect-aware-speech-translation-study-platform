// Next.js 16 Proxy (the successor of middleware.ts). It runs in the Node.js runtime
// before every matched request and does two things:
//
// 1. Admin access gate (spec 39). Requests for /admin/** without a valid session are
//    redirected to /admin/login?next=<path>; requests for /api/admin/** get a 401 JSON
//    error. The session cookie is fully unsealed and its expiry and password binding
//    are checked here. This gate is the first of two layers: apiRoute({ auth: "admin" })
//    and requireAdminPage() verify the session again next to the data, and also
//    reject a cookie issued before the last sign-out (that check needs the database).
//
//    The check here is weaker than the check of the pages, so this gate only ever
//    refuses. It never sends a visitor away from /admin/login: a cookie that passes
//    here can still be refused by requireAdminPage(), and a redirect from the login
//    page to /admin would then loop (defect E2E-3). The login page itself redirects
//    a signed-in visitor, after the full check.
//
//    A cookie that fails the check here (forged, expired, sealed under another
//    password or secret) is removed with the response.
// 2. Content Security Policy with a per-request nonce for HTML pages (spec 67).
//
// Proxy code reads only process.env and pure helpers. It does not open database
// connections and does not share module state with route handlers.
import { NextResponse, type NextRequest } from "next/server";
import { adminCookieName, adminPasswordTag, safeAdminNextPath, unsealAdminSession } from "./lib/server/admin-session";
import { buildContentSecurityPolicy, generateNonce } from "./lib/server/security-headers";

// Must match PATHNAME_HEADER in lib/server/admin-auth.ts.
const PATHNAME_HEADER = "x-dts-pathname";
const LOGIN_PAGE = "/admin/login";
const LOGIN_API = "/api/admin/login";

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

// "valid": the cookie passes the checks that need no database. "rejected": a
// cookie is present and fails them. "absent": no cookie.
type AdminCookieState = "valid" | "rejected" | "absent";

async function adminCookieState(request: NextRequest): Promise<AdminCookieState> {
  // `__Host-dts_admin` over https in production, `dts_admin` otherwise.
  const sealed = request.cookies.get(adminCookieName())?.value;
  if (!sealed) return "absent";
  const secret = process.env.ADMIN_SESSION_SECRET;
  const password = process.env.ADMIN_PASSWORD;
  if (!secret || secret.length < 32 || !password) return "rejected";
  // A cookie issued under another admin password is rejected here too. The
  // sign-out time is checked by the second layer, which reads the database.
  const session = await unsealAdminSession(sealed, secret, new Date(), adminPasswordTag(password, secret));
  return session === null ? "rejected" : "valid";
}

// Removes a rejected cookie: an expired cookie with the same attributes as the
// one set by createAdminSession (lib/server/admin-auth.ts).
function clearAdminCookie(response: NextResponse): NextResponse {
  response.cookies.set(adminCookieName(), "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

function redirectTo(request: NextRequest, pathname: string, next?: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  if (next) url.searchParams.set("next", next);
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  // API routes: only the admin gate applies. Their other headers come from next.config.ts.
  if (isUnder(pathname, "/api")) {
    if (isUnder(pathname, "/api/admin") && pathname !== LOGIN_API) {
      const state = await adminCookieState(request);
      if (state !== "valid") {
        const response = NextResponse.json(
          { error: { code: "UNAUTHORIZED", message: "Admin sign-in is required." } },
          { status: 401, headers: { "Cache-Control": "no-store, private" } },
        );
        return state === "rejected" ? clearAdminCookie(response) : response;
      }
    }
    return NextResponse.next();
  }

  let rejectedCookie = false;
  if (isUnder(pathname, "/admin")) {
    const state = await adminCookieState(request);
    rejectedCookie = state === "rejected";
    // The login page is always let through, also with a cookie that is valid
    // here: only the page can make the full check.
    if (pathname !== LOGIN_PAGE && state !== "valid") {
      const response = redirectTo(request, LOGIN_PAGE, safeAdminNextPath(`${pathname}${search}`));
      return rejectedCookie ? clearAdminCookie(response) : response;
    }
  }

  // HTML pages: a fresh nonce per request. Next.js reads the nonce from the
  // Content-Security-Policy request header and adds it to its script tags.
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV === "development",
    upgradeInsecureRequests: (process.env.APP_URL ?? "").startsWith("https://"),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  // Overwrites any value a client sent, so requireAdminPage() can trust it.
  requestHeaders.set(PATHNAME_HEADER, `${pathname}${search}`);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return rejectedCookie ? clearAdminCookie(response) : response;
}

export const config = {
  matcher: [
    // Everything except build assets and the audio upload routes. API routes are
    // included for the admin gate. A matched request has its body buffered in
    // memory and cut at 10 MB (experimental.proxyClientMaxBodySize), which would
    // damage a large audio upload. See docs/PARTICIPANT-API.md, "Large uploads".
    //
    // Left out, each one because it does not depend on the proxy:
    // - /api/study/**: the participant API. The proxy does nothing for it.
    // - /api/demo/recordings (exactly): the demo upload. The proxy does nothing
    //   for /api/demo. The route checks the demo access setting, the demo cookie
    //   and the request origin itself.
    // - /api/admin/ai/test (exactly): the pipeline test upload. The proxy gate is
    //   only the first of two layers. The route verifies the admin session and
    //   the request origin itself with apiRoute({ auth: "admin" }).
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|api/study/|api/demo/recordings$|api/admin/ai/test$).*)",
  ],
};
