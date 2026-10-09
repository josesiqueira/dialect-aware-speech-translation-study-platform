// Route tests for the Processing Runs API: sign-in, same-origin check, input
// validation and the mapping of service errors to HTTP responses. The rules
// themselves are tested in packages/research/src/processing.
import { beforeAll, describe, expect, it } from "vitest";
import {
  insertActiveAiConfigs,
  insertPublishedProtocol,
  insertSessionWithUtterance,
  insertStudy,
  insertTranscriptWithRevision,
} from "@dialect/db/testing-builders";
import { createAdminSession } from "@/lib/server/admin-auth";
import { jsonRequest, setupServerTestHarness } from "@/lib/server/test/database";
import { POST as cancel } from "./[id]/cancel/route";
import { GET as listJobs } from "./[id]/jobs/route";
import { POST as retryFailed } from "./[id]/retry-failed/route";
import { GET as getBatch } from "./[id]/route";
import { POST as start } from "./[id]/start/route";
import { POST as preview } from "./preview/route";
import { GET as list, POST as create } from "./route";

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000/api/admin/processing";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const none = { params: Promise.resolve({}) } as { params: Promise<Record<string, never>> };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path = "") => jsonRequest(`${BASE}${path}`, { method: "GET" });
const post = (path = "", body?: unknown, options: { sameOrigin?: boolean } = {}) =>
  jsonRequest(`${BASE}${path}`, { method: "POST", body, ...options });

let studyId: string;

beforeAll(async () => {
  const db = harness.database.db;
  const study = await insertStudy(db, { settingsJson: { sourceLanguage: "fi", targetLanguage: "en" } });
  studyId = study.id;
  const { protocol } = await insertPublishedProtocol(db, { studyId });
  // The session below is research data, which the mock provider may not process.
  // The batch is planned and queued here, never run, so no provider is called.
  await insertActiveAiConfigs(db, { studyId, provider: "openai" });
  const collected = await insertSessionWithUtterance(db, {
    studyId,
    protocolVersionId: protocol.id,
    session: { status: "completed", completedAt: new Date() },
  });
  await insertTranscriptWithRevision(db, {
    utteranceId: collected.utterance.id,
    type: "human_dialect",
    status: "verified",
    revision: { verifiedAt: new Date(), verifiedByLabel: "JS" },
  });
});

describe("authentication and origin", () => {
  it("rejects every route without an admin session", async () => {
    const responses = await Promise.all([
      list(get(), none),
      create(post("", { name: "X" }), none),
      preview(post("/preview", {}), none),
      getBatch(get(`/${UNKNOWN_ID}`), withId(UNKNOWN_ID)),
      start(post(`/${UNKNOWN_ID}/start`), withId(UNKNOWN_ID)),
      retryFailed(post(`/${UNKNOWN_ID}/retry-failed`), withId(UNKNOWN_ID)),
      cancel(post(`/${UNKNOWN_ID}/cancel`), withId(UNKNOWN_ID)),
      listJobs(get(`/${UNKNOWN_ID}/jobs`), withId(UNKNOWN_ID)),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHORIZED");
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    }
  });

  it("rejects a state-changing request from another origin", async () => {
    await createAdminSession();
    const response = await create(
      jsonRequest(BASE, { method: "POST", body: { name: "X" }, headers: { origin: "https://evil.example" } }),
      none,
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });
});

describe("validation", () => {
  it("rejects malformed input with VALIDATION_ERROR", async () => {
    await createAdminSession();
    const cases = await Promise.all([
      create(post("", { description: "no name" }), none),
      create(post("", { name: "X", unknownField: true }), none),
      create(post("", { name: "X", transcriptTypes: ["shorthand"] }), none),
      create(post("", { name: "X", selection: { mode: "production" } }), none),
      create(post("", { name: "X", translationModelConfigIds: ["not-a-uuid"] }), none),
      preview(post("/preview", { selection: { dateFrom: "yesterday" } }), none),
      getBatch(get("/not-a-uuid"), withId("not-a-uuid")),
      start(post("/not-a-uuid/start"), withId("not-a-uuid")),
      listJobs(get(`/${UNKNOWN_ID}/jobs?status=sleeping`), withId(UNKNOWN_ID)),
      list(get("?page=0"), none),
    ]);
    for (const response of cases) {
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    }
    const malformed = await create(
      new Request(BASE, { method: "POST", body: "{", headers: { origin: "http://localhost:3000", "content-type": "application/json" } }),
      none,
    );
    expect(malformed.status).toBe(400);
  });

  it("answers 404 for a batch that does not exist", async () => {
    await createAdminSession();
    const responses = await Promise.all([
      getBatch(get(`/${UNKNOWN_ID}`), withId(UNKNOWN_ID)),
      start(post(`/${UNKNOWN_ID}/start`), withId(UNKNOWN_ID)),
      cancel(post(`/${UNKNOWN_ID}/cancel`), withId(UNKNOWN_ID)),
      retryFailed(post(`/${UNKNOWN_ID}/retry-failed`), withId(UNKNOWN_ID)),
      listJobs(get(`/${UNKNOWN_ID}/jobs`), withId(UNKNOWN_ID)),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
    }
  });
});

describe("batch workflow", () => {
  it("previews, creates, starts, lists and cancels a batch", async () => {
    await createAdminSession();

    const previewResponse = await preview(post("/preview", { transcriptTypes: ["human_dialect"] }), none);
    expect(previewResponse.status).toBe(200);
    const previewBody = await previewResponse.json();
    expect(previewBody.preview).toMatchObject({
      utteranceCount: 1,
      dataMode: "research",
      estimatedJobCounts: { asr: 0, translation: 2, tts: 2, total: 4 },
    });
    expect(previewBody.preview.configuration).not.toHaveProperty("utteranceIds");
    expect(previewBody.preview.configuration.translations).toHaveLength(2);

    const createResponse = await create(post("", { name: "Route batch", transcriptTypes: ["human_dialect"] }), none);
    expect(createResponse.status).toBe(200);
    const { batch } = await createResponse.json();
    expect(batch).toMatchObject({ name: "Route batch", status: "draft", createdByLabel: "admin", utteranceCount: 1 });
    expect(batch.configuration.translations[0].promptText).toEqual(expect.any(String));

    const duplicate = await create(post("", { name: "Route batch", transcriptTypes: ["human_dialect"] }), none);
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe("CONFLICT");

    const startResponse = await start(post(`/${batch.id}/start`), withId(batch.id));
    expect(startResponse.status).toBe(200);
    expect((await startResponse.json()).batch).toMatchObject({ status: "queued", jobCounts: { queued: 2, total: 2 } });

    const again = await start(post(`/${batch.id}/start`), withId(batch.id));
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("INVALID_STATE");

    const jobsResponse = await listJobs(get(`/${batch.id}/jobs?status=queued&pageSize=1`), withId(batch.id));
    expect(jobsResponse.status).toBe(200);
    const jobsBody = await jobsResponse.json();
    expect(jobsBody).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(jobsBody.jobs).toHaveLength(1);
    expect(jobsBody.jobs[0]).toMatchObject({ type: "translation", status: "queued" });

    const listResponse = await list(get(), none);
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.total).toBe(1);
    expect(listBody.batches[0]).toMatchObject({ id: batch.id, status: "queued" });
    expect(listBody.batches[0]).not.toHaveProperty("configuration");

    const detail = await getBatch(get(`/${batch.id}`), withId(batch.id));
    expect((await detail.json()).batch).toMatchObject({ id: batch.id, failedJobs: [] });

    const cancelResponse = await cancel(post(`/${batch.id}/cancel`), withId(batch.id));
    expect(cancelResponse.status).toBe(200);
    expect((await cancelResponse.json()).batch).toMatchObject({ status: "cancelled", jobCounts: { cancelled: 2 } });

    const retry = await retryFailed(post(`/${batch.id}/retry-failed`), withId(batch.id));
    expect(retry.status).toBe(409);
    expect((await retry.json()).error.code).toBe("INVALID_STATE");
  });

  it("answers 422 with a clear message when a needed configuration is missing", async () => {
    await createAdminSession();
    const response = await create(post("", { name: "ASR batch", runAsr: true, asrModelConfigId: UNKNOWN_ID }), none);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("CONFIGURATION_MISSING");
    expect(body.error.message).toContain("does not exist");
  });
});
