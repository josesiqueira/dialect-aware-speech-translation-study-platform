import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adminAuditLog, studies } from "@dialect/db";
import { AppError } from "@dialect/domain";
import { recordAudit } from "@dialect/research";
import { createAdminSession } from "./admin-auth";
import { apiRoute, getRouteParams, jsonOk, parseJsonBody, parseQuery, toAppError } from "./api";
import { jsonRequest, noParams, setupServerTestHarness } from "./test/database";
import { fakeCookies } from "./test/request-scope";
import { TEST_ENV } from "./test/setup";

const harness = setupServerTestHarness();
const URL_BASE = "http://localhost:3000";

function get(path: string, headers?: Record<string, string>): Request {
  return new Request(`${URL_BASE}${path}`, { method: "GET", headers });
}

async function run(handler: Parameters<typeof apiRoute>[0], request: Request = get("/api/test")) {
  const response = await apiRoute(handler, { auth: "public" })(request, noParams);
  return { response, body: await response.json() };
}

describe("apiRoute error mapping", () => {
  it("passes a successful response through with a request id", async () => {
    const { response, body } = await run(async () => jsonOk({ value: 1 }));
    expect(response.status).toBe(200);
    expect(body).toEqual({ value: 1 });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("maps AppError to its code, status and details", async () => {
    const { response, body } = await run(async () => {
      throw new AppError("NOT_FOUND", "Session not found.", { id: "abc" });
    });
    expect(response.status).toBe(404);
    expect(body).toEqual({ error: { code: "NOT_FOUND", message: "Session not found.", details: { id: "abc" } } });

    const closed = await run(async () => {
      throw new AppError("STUDY_CLOSED", "The study is closed.");
    });
    expect(closed.response.status).toBe(403);
    expect(closed.body).toEqual({ error: { code: "STUDY_CLOSED", message: "The study is closed." } });
  });

  it("maps a Zod error to VALIDATION_ERROR 400 with field issues", async () => {
    const schema = z.object({ name: z.string().min(2), nested: z.object({ count: z.number().int() }) });
    const request = jsonRequest(`${URL_BASE}/api/test`, { body: { name: "x", nested: { count: "many" } } });
    const { response, body } = await run(async (req) => jsonOk(await parseJsonBody(req, schema)), request);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.issues.map((issue: { path: string }) => issue.path).sort()).toEqual(["name", "nested.count"]);
    expect(body.error.details.issues[0].message).toEqual(expect.any(String));
  });

  it("maps malformed JSON to VALIDATION_ERROR", async () => {
    const request = new Request(`${URL_BASE}/api/test`, { method: "POST", body: "{not json", headers: { origin: URL_BASE } });
    const { response, body } = await run(async (req) => jsonOk(await parseJsonBody(req, z.object({}))), request);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("maps a PostgreSQL immutability trigger error to IMMUTABLE_RECORD 409", async () => {
    const db = harness.database.db;
    await recordAudit(db, { action: "settings.update", entityType: "study", actorLabel: "admin" });
    const { response, body } = await run(async ({}, { ctx }) => {
      // admin_audit_log is append-only: the trigger rejects this update.
      await ctx.db.update(adminAuditLog).set({ actorLabel: "changed" });
      return jsonOk({});
    });
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("IMMUTABLE_RECORD");
    expect(body.error.message).not.toContain("Failed query");
  });

  it("maps a raised IMMUTABLE_RECORD message without the custom SQLSTATE too", async () => {
    const { response, body } = await run(async ({}, { ctx }) => {
      await ctx.db.execute(sql`do $$ begin raise exception 'IMMUTABLE_RECORD: protocol_versions: published'; end $$`);
      return jsonOk({});
    });
    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({ code: "IMMUTABLE_RECORD", details: { reason: "protocol_versions: published" } });
  });

  it("maps a unique violation (SQLSTATE 23505) to CONFLICT 409", async () => {
    const { response, body } = await run(async ({}, { ctx }) => {
      await ctx.db.insert(studies).values({ slug: "duplicate-slug", name: "One" });
      await ctx.db.insert(studies).values({ slug: "duplicate-slug", name: "Two" });
      return jsonOk({});
    });
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
    expect(JSON.stringify(body)).not.toContain("duplicate-slug");
  });

  it("maps anything else to a generic INTERNAL_ERROR without leaking internals", async () => {
    const { response, body } = await run(async () => {
      const cause = new Error(`OpenAI request failed: Incorrect API key provided: ${TEST_ENV.OPENAI_API_KEY}`);
      throw new TypeError("Cannot read properties of undefined (reading 'secretField')", { cause });
    });
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL_ERROR", message: expect.any(String) } });
    const text = JSON.stringify(body);
    expect(text).not.toContain("secretField");
    expect(text).not.toContain("OpenAI");
    expect(text).not.toContain("at ");
    expect(text).not.toContain(TEST_ENV.OPENAI_API_KEY);

    // The server log has the details for debugging, but never the key itself.
    const log = harness.logLines.join("");
    expect(log).toContain("secretField");
    expect(log).toContain("Incorrect API key provided");
    expect(log).not.toContain(TEST_ENV.OPENAI_API_KEY);
  });

  it("handles thrown values that are not Error objects", async () => {
    const { response, body } = await run(async () => {
      throw "plain string";
    });
    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(toAppError(null).code).toBe("INTERNAL_ERROR");
  });
});

describe("apiRoute logging", () => {
  it("logs request id, method, route, status and duration, and never the body", async () => {
    const request = jsonRequest(`${URL_BASE}/api/study/consent?debug=query-secret`, {
      body: { transcript: "minä puhun murretta", consentAnswer: "yes-to-everything" },
    });
    const { response } = await run(async (req) => {
      await req.json();
      return jsonOk({ ok: true });
    }, request);

    expect(harness.logLines).toHaveLength(1);
    const entry = JSON.parse(harness.logLines[0]);
    expect(entry).toMatchObject({
      requestId: response.headers.get("x-request-id"),
      method: "POST",
      route: "/api/study/consent",
      status: 200,
      msg: "request",
    });
    expect(entry.durationMs).toEqual(expect.any(Number));
    const line = harness.logLines[0];
    expect(line).not.toContain("murretta");
    expect(line).not.toContain("yes-to-everything");
    expect(line).not.toContain("query-secret");
  });

  it("does not log SQL parameters of a failed query", async () => {
    await run(async ({}, { ctx }) => {
      await ctx.db.execute(sql`select ${"participant said something private"}::int`);
      return jsonOk({});
    });
    const log = harness.logLines.join("");
    expect(log).toContain("database query failed");
    expect(log).not.toContain("something private");
  });
});

describe("apiRoute with auth admin", () => {
  const adminGet = apiRoute(async ({}, { actorLabel, session, ctx }) => jsonOk({ actorLabel, role: session?.role, ctxActor: ctx.actorLabel }), {
    auth: "admin",
  });
  const adminPost = apiRoute(async () => jsonOk({ changed: true }), { auth: "admin" });

  it("returns 401 and no-store without a session", async () => {
    const response = await adminGet(get("/api/admin/sessions"), noParams);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns 401 for an invalid cookie", async () => {
    fakeCookies.setRequestCookie("dts_admin", "forged-value");
    const response = await adminGet(get("/api/admin/sessions"), noParams);
    expect(response.status).toBe(401);
  });

  it("passes the actor label with a valid session and forces no-store, private", async () => {
    await createAdminSession();
    const handler = apiRoute(async () => jsonOk({ ok: true }, { headers: { "Cache-Control": "public, max-age=600" } }), { auth: "admin" });
    const cached = await handler(get("/api/admin/sessions"), noParams);
    expect(cached.headers.get("cache-control")).toBe("no-store, private");

    const response = await adminGet(get("/api/admin/sessions"), noParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actorLabel: "admin", role: "admin", ctxActor: "admin" });
  });

  it("rejects a cross-origin state-changing request even with a valid session", async () => {
    await createAdminSession();
    const post = (headers: Record<string, string>) =>
      adminPost(new Request(`${URL_BASE}/api/admin/protocols`, { method: "POST", headers }), noParams);

    const crossOrigin = await post({ origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json()).error.code).toBe("FORBIDDEN");
    expect(crossOrigin.headers.get("cache-control")).toBe("no-store, private");

    expect((await post({ "sec-fetch-site": "cross-site", origin: URL_BASE })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    // Neither header: not a browser request from the app, rejected.
    expect((await post({})).status).toBe(403);

    expect((await post({ origin: URL_BASE })).status).toBe(200);
    expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("does not require an origin header for reads", async () => {
    await createAdminSession();
    expect((await adminGet(get("/api/admin/sessions"), noParams)).status).toBe(200);
  });
});

describe("helpers", () => {
  it("resolves Promise-based route params and passes them to the handler", async () => {
    const handler = apiRoute<{ id: string }>(async ({}, { params }) => jsonOk({ id: params.id }), { auth: "public" });
    const context = { params: Promise.resolve({ id: "u-1" }) };
    expect(await (await handler(get("/api/test/u-1"), context)).json()).toEqual({ id: "u-1" });
    expect(await getRouteParams(context)).toEqual({ id: "u-1" });
    await expect(getRouteParams(context, z.object({ id: z.uuid() }))).rejects.toBeInstanceOf(z.ZodError);
  });

  it("parses the query string, keeping repeated keys as arrays", () => {
    const schema = z.object({
      page: z.coerce.number().int().default(1),
      status: z.union([z.string(), z.array(z.string())]).optional(),
    });
    expect(parseQuery(get("/api/test?page=3&status=a&status=b"), schema)).toEqual({ page: 3, status: ["a", "b"] });
    expect(parseQuery(get("/api/test"), schema)).toEqual({ page: 1 });
    expect(() => parseQuery(get("/api/test?page=x"), schema)).toThrow(z.ZodError);
  });
});
