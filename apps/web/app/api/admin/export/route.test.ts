// Route tests for the export API: sign-in, same-origin check, input validation
// and the default filters. The export rules themselves are tested in
// packages/research/src/exports.
import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { adminAuditLog, exportJobs, jobs, sessions } from "@dialect/db";
import { insertSessionWithUtterance, insertStudy, insertPublishedProtocol } from "@dialect/db/testing-builders";
import { exports as dataExports, processOneJob } from "@dialect/research";
import { generateSineWav, sha256OfBuffer } from "@dialect/storage";
import { createAdminSession } from "@/lib/server/admin-auth";
import { getServiceContext } from "@/lib/server/context";
import { jsonRequest, setupServerTestHarness } from "@/lib/server/test/database";
import { GET as dictionary } from "./dictionary/route";
import { GET as download } from "./jobs/[id]/download/route";
import { GET as jobStatus } from "./jobs/[id]/route";
import { GET as listJobs, POST as createJob } from "./jobs/route";
import { GET as preview } from "./preview/route";
import { GET as exportTable } from "./route";

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000/api/admin/export";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const none = { params: Promise.resolve({}) } as { params: Promise<Record<string, never>> };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path = "") => jsonRequest(`${BASE}${path}`, { method: "GET" });
const post = (path: string, body?: unknown, options: { sameOrigin?: boolean } = {}) =>
  jsonRequest(`${BASE}${path}`, { method: "POST", body, ...options });

const WAV = generateSineWav({ durationMs: 100, sampleRateHz: 8000, frequencyHz: 440 });
const codes = { research: "P-RESEARCH1", demo: "P-DEMODEMO2", test: "P-TESTTEST3", incomplete: "P-INCOMPL4" };
const wavKeys: string[] = [];

beforeAll(async () => {
  const db = harness.database.db;
  const study = await insertStudy(db, { slug: "route-study" });
  const { protocol } = await insertPublishedProtocol(db, { studyId: study.id });
  const add = async (code: string, mode: "research" | "demo" | "test", status: "completed" | "recording") => {
    const key = `test/${code}.wav`;
    wavKeys.push(key);
    await insertSessionWithUtterance(db, {
      studyId: study.id,
      protocolVersionId: protocol.id,
      session: { participantCode: code, mode, status, completedAt: status === "completed" ? new Date() : null },
      media: { storageKey: key, storageDriver: "memory", sha256: sha256OfBuffer(WAV), sizeBytes: WAV.length, durationMs: 100 },
    });
  };
  await add(codes.research, "research", "completed");
  await add(codes.demo, "demo", "completed");
  await add(codes.test, "test", "completed");
  await add(codes.incomplete, "research", "recording");
});

// The harness gives every test a new in-memory storage.
async function storeAudio(): Promise<void> {
  for (const key of wavKeys) await harness.storage.put({ key, body: WAV, contentType: "audio/wav" });
}

describe("authentication and origin", () => {
  it("rejects every route without an admin session", async () => {
    const responses = await Promise.all([
      exportTable(get("?table=sessions"), none),
      preview(get("/preview"), none),
      dictionary(get("/dictionary"), none),
      listJobs(get("/jobs"), none),
      createJob(post("/jobs", { exportType: "dataset_package" }), none),
      jobStatus(get(`/jobs/${UNKNOWN_ID}`), withId(UNKNOWN_ID)),
      download(get(`/jobs/${UNKNOWN_ID}/download`), withId(UNKNOWN_ID)),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    }
    expect(await harness.database.db.select().from(exportJobs)).toEqual([]);
  });

  it("rejects a cross-origin request to create an export", async () => {
    await createAdminSession();
    const response = await createJob(post("/jobs", { exportType: "dataset_package" }, { sameOrigin: false }), none);
    expect(response.status).toBe(403);
  });
});

describe("GET /api/admin/export", () => {
  it("streams a CSV with research, completed sessions only by default", async () => {
    await createAdminSession();
    const response = await exportTable(get("?table=sessions"), none);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="sessions-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const body = await response.text();
    expect(body).toContain(codes.research);
    for (const code of [codes.demo, codes.test, codes.incomplete]) expect(body).not.toContain(code);
    expect(body.split("\r\n")[0]).toContain("session_id,participant_code");

    const [audit] = await harness.database.db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(1);
    expect(audit).toMatchObject({ action: "export.create", actorLabel: "admin" });
  });

  it("includes test and incomplete sessions only when the query asks for them", async () => {
    await createAdminSession();
    const withTest = await (await exportTable(get("?table=sessions&includeTest=true"), none)).text();
    expect(withTest).toContain(codes.test);
    expect(withTest).not.toContain(codes.demo);
    const everything = await (
      await exportTable(get("?table=sessions&format=json&modes=research,demo,test&completedOnly=false"), none)
    ).json();
    expect(everything.map((row: { participant_code: string }) => row.participant_code).sort()).toEqual(Object.values(codes).sort());
  });

  it("validates the table, the format, the filters and the privacy tier", async () => {
    await createAdminSession();
    const cases = [
      "",
      "?table=passwords",
      "?table=sessions&format=xml",
      "?table=model_runs&format=csv",
      "?table=sessions&includeTest=maybe",
      "?table=sessions&dateFrom=yesterday",
      "?table=sessions&sessionIds=not-a-uuid",
      "?table=sessions&unknownFilter=1",
      "?table=sessions&privacyTier=public_release",
      "?table=researcher_notes",
    ];
    for (const query of cases) {
      const response = await exportTable(get(query), none);
      expect(response.status, query).toBe(400);
      expect((await response.json()).error.code, query).toBe("VALIDATION_ERROR");
    }
  });
});

describe("GET /api/admin/export/preview", () => {
  it("counts with the default filters and with explicit ones", async () => {
    await createAdminSession();
    const defaults = await (await preview(get("/preview"), none)).json();
    expect(defaults.preview).toMatchObject({ sessions: 1, utterances: 1, sourceAudioFiles: 1, sourceAudioDurationMs: 100, modes: ["research"] });
    const all = await (await preview(get("/preview?includeDemo=true&includeTest=true&completedOnly=false"), none)).json();
    expect(all.preview).toMatchObject({ sessions: 4, utterances: 4, modes: ["research", "demo", "test"] });
    expect((await preview(get("/preview?privacyTier=public_release"), none)).status).toBe(400);
  });
});

describe("GET /api/admin/export/dictionary", () => {
  it("returns the dictionary as Markdown or JSON", async () => {
    await createAdminSession();
    const markdown = await dictionary(get("/dictionary"), none);
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await markdown.text()).toContain("## sessions.csv");
    const json = await (await dictionary(get("/dictionary?format=json&privacyTier=analysis_pseudonymous"), none)).json();
    const names = json.fields.filter((field: { table: string }) => field.table === "sessions").map((field: { name: string }) => field.name);
    expect(names).toContain("participant_code");
    expect(names).not.toContain("user_agent");
    expect((await dictionary(get("/dictionary?privacyTier=public_release"), none)).status).toBe(400);
  });
});

describe("export jobs", () => {
  it("validates the body", async () => {
    await createAdminSession();
    const bodies = [
      {},
      { exportType: "everything" },
      { exportType: "dataset_package", privacyTier: "public_release" },
      { exportType: "dataset_package", filters: { modes: ["production"] } },
      { exportType: "dataset_package", filters: { surprise: true } },
      { exportType: "session_package" },
      { exportType: "source_audio_zip", privacyTier: "analysis_pseudonymous" },
    ];
    for (const body of bodies) {
      const response = await createJob(post("/jobs", body), none);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await harness.database.db.select().from(exportJobs)).toEqual([]);
  });

  it("creates a queued job, reports its status, and serves the archive after the worker ran", async () => {
    await createAdminSession();
    await storeAudio();
    const created = await (await createJob(post("/jobs", { exportType: "dataset_package" }), none)).json();
    expect(created.job).toMatchObject({ status: "queued", exportType: "dataset_package", privacyTier: "internal_full", filters: {} });
    const id = created.job.id as string;

    const list = await (await listJobs(get("/jobs"), none)).json();
    expect(list.items[0]).toMatchObject({ id, status: "queued" });
    expect(list.workerHealthy).toBe(false);

    const early = await download(get(`/jobs/${id}/download`), withId(id));
    expect(early.status).toBe(409);

    harness.advanceSeconds(60);
    await processOneJob({ deps: { ctx: getServiceContext(null) }, handlers: dataExports.jobHandlers, workerId: "route-test" });
    const status = await (await jobStatus(get(`/jobs/${id}`), withId(id))).json();
    expect(status.job).toMatchObject({ status: "completed", errorMessage: null });
    expect(status.job.sizeBytes).toBeGreaterThan(0);
    expect(status.job.summary).toMatchObject({ sessions: 1, utterances: 1, sourceAudioFiles: 1 });

    const archive = await download(get(`/jobs/${id}/download`), withId(id));
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/zip");
    expect(archive.headers.get("content-disposition")).toBe(`attachment; filename="${status.job.fileName}"`);
    expect(archive.headers.get("cache-control")).toBe("no-store, private");
    const bytes = Buffer.from(await archive.arrayBuffer());
    expect(bytes.length).toBe(status.job.sizeBytes);
    expect(sha256OfBuffer(bytes)).toBe(status.job.sha256);
    expect(bytes.includes(Buffer.from(`source_audio/${codes.research}_U-01_source.wav`))).toBe(true);
    for (const code of [codes.demo, codes.test, codes.incomplete]) expect(bytes.includes(Buffer.from(code))).toBe(false);

    const audits = await harness.database.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, id));
    expect(audits.map((row) => row.action).sort()).toEqual(["export.create", "export.download"]);
  });

  it("builds a session package during the request and serves it from the download route", async () => {
    await createAdminSession();
    await storeAudio();
    const db = harness.database.db;
    // A test-mode session: a session package is built for any mode.
    const [session] = await db.select().from(sessions).where(eq(sessions.participantCode, codes.test));
    const response = await createJob(
      post("/jobs", { exportType: "session_package", filters: { sessionIds: [session!.id] } }),
      none,
    );
    expect(response.status).toBe(200);
    const { job } = await response.json();
    expect(job).toMatchObject({
      exportType: "session_package",
      privacyTier: "internal_full",
      status: "completed",
      errorMessage: null,
      createdByLabel: "admin",
      filters: { sessionIds: [session!.id] },
    });
    expect(job.fileName).toMatch(/\.zip$/);
    expect(job.sizeBytes).toBeGreaterThan(0);
    expect(job.summary).toMatchObject({ sessions: 1, utterances: 1, sourceAudioFiles: 1 });
    // Nothing waits in the queue: no worker is needed.
    const queued = await db.select().from(jobs).where(eq(jobs.idempotencyKey, `export:${job.id}`));
    expect(queued).toEqual([]);

    const archive = await download(get(`/jobs/${job.id}/download`), withId(job.id));
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/zip");
    expect(archive.headers.get("content-disposition")).toBe(`attachment; filename="${job.fileName}"`);
    const bytes = Buffer.from(await archive.arrayBuffer());
    expect(bytes.length).toBe(job.sizeBytes);
    expect(sha256OfBuffer(bytes)).toBe(job.sha256);
    expect(bytes.includes(Buffer.from(`source_audio/${codes.test}_U-01_source.wav`))).toBe(true);
    // Only this session is in the package.
    for (const code of [codes.research, codes.demo, codes.incomplete]) expect(bytes.includes(Buffer.from(code))).toBe(false);

    const audits = await db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, job.id));
    expect(audits.map((row) => row.action).sort()).toEqual(["export.create", "export.download"]);
    expect(audits.every((row) => row.actorLabel === "admin")).toBe(true);
  });

  it("refuses a session package for an unknown session, several sessions or another privacy tier", async () => {
    await createAdminSession();
    const db = harness.database.db;
    const before = (await db.select().from(exportJobs)).length;
    const [session] = await db.select().from(sessions).where(eq(sessions.participantCode, codes.research));
    const unknown = await createJob(post("/jobs", { exportType: "session_package", filters: { sessionIds: [UNKNOWN_ID] } }), none);
    expect(unknown.status).toBe(404);
    const several = await createJob(
      post("/jobs", { exportType: "session_package", filters: { sessionIds: [session!.id, UNKNOWN_ID] } }),
      none,
    );
    expect(several.status).toBe(400);
    const tier = await createJob(
      post("/jobs", {
        exportType: "session_package",
        privacyTier: "analysis_pseudonymous",
        filters: { sessionIds: [session!.id] },
      }),
      none,
    );
    expect(tier.status).toBe(400);
    expect((await db.select().from(exportJobs)).length).toBe(before);
  });

  it("returns 404 for an unknown job and 400 for a malformed id", async () => {
    await createAdminSession();
    expect((await jobStatus(get(`/jobs/${UNKNOWN_ID}`), withId(UNKNOWN_ID))).status).toBe(404);
    expect((await download(get(`/jobs/${UNKNOWN_ID}/download`), withId(UNKNOWN_ID))).status).toBe(404);
    expect((await jobStatus(get("/jobs/abc"), withId("abc"))).status).toBe(400);
  });
});
