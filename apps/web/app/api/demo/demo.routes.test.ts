// Route tests of Demo Mode (/api/demo/*) and of the admin pipeline test
// (/api/admin/ai/test): who may call them, that a visitor only reaches the
// audio of their own demo session, and how uploads are bounded.
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  adminAuditLog,
  mediaAssets,
  processingBatches,
  rateLimitHits,
  sessions,
  studies,
  utterances,
  type StudySettings,
} from "@dialect/db";
import {
  insertActiveAiConfigs,
  insertPublishedProtocol,
  insertSessionWithUtterance,
  insertStudy,
} from "@dialect/db/testing-builders";
import type { demoSchemas } from "@dialect/domain";
import { sessions as sessionService } from "@dialect/research";
import { generateSineWav } from "@dialect/storage";
import { createAdminSession } from "@/lib/server/admin-auth";
import { jsonRequest, noParams, setupServerTestHarness } from "@/lib/server/test/database";
import { fakeCookies } from "@/lib/server/test/request-scope";
import { getServiceContext } from "@/lib/server/context";
import { GET as lastPipelineTest, POST as runPipelineTest } from "../admin/ai/test/route";
import { DEMO_COOKIE_NAME, DEMO_RECORDING_LIMIT } from "./_lib/demo";
import { GET as media } from "./media/[id]/route";
import { GET as countLeftovers, POST as purgeLeftovers } from "./purge-leftovers/route";
import { POST as runRecording } from "./recordings/[id]/run/route";
import { POST as uploadRecording } from "./recordings/route";
import { POST as endByBeacon } from "./session/end/route";
import { DELETE as endSession, GET as getSession, POST as startSession } from "./session/route";

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000";
const BASE_SETTINGS: StudySettings = {
  allowNewSessions: true,
  sourceLanguage: "fi",
  targetLanguage: "en",
  demoPublic: false,
  demoPersist: true,
};

let studyId: string;
let protocolId: string;
let toneCounter = 0;

beforeAll(async () => {
  const db = harness.database.db;
  const study = await insertStudy(db, { name: "Demo route test study", settingsJson: BASE_SETTINGS });
  studyId = study.id;
  protocolId = (await insertPublishedProtocol(db, { studyId })).protocol.id;
  // Active configurations with the mock provider: no route test calls a real model.
  await insertActiveAiConfigs(db, { studyId });
});

beforeEach(async () => {
  const db = harness.database.db;
  await db.update(studies).set({ settingsJson: BASE_SETTINGS }).where(eq(studies.id, studyId));
  await db.delete(rateLimitHits);
});

async function setSettings(settings: StudySettings): Promise<void> {
  await harness.database.db
    .update(studies)
    .set({ settingsJson: { ...BASE_SETTINGS, ...settings } })
    .where(eq(studies.id, studyId));
}

const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path: string) => new Request(`${BASE}${path}`, { method: "GET" });
const post = (path: string, body?: unknown, options: { sameOrigin?: boolean } = {}) =>
  jsonRequest(`${BASE}${path}`, { body: body ?? {}, ...options });

function wav(durationMs = 400): Buffer {
  toneCounter += 1;
  return generateSineWav({ durationMs, sampleRateHz: 16000, frequencyHz: 250 + toneCounter * 5 });
}

function uploadRequest(
  path: string,
  options: { data?: Buffer; metadata?: unknown; options?: unknown; headers?: Record<string, string>; partName?: string } = {},
): Request {
  const form = new FormData();
  form.set(options.partName ?? "audio", new Blob([new Uint8Array(options.data ?? wav())], { type: "audio/wav" }), "recording.wav");
  if (options.metadata !== undefined) form.set("metadata", JSON.stringify(options.metadata));
  if (options.options !== undefined) form.set("options", JSON.stringify(options.options));
  return new Request(`${BASE}${path}`, { method: "POST", body: form, headers: { origin: BASE, ...options.headers } });
}

async function ok<T>(response: Response): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as T;
}

async function fails(response: Response, status: number, code: string): Promise<{ code: string; message: string }> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
  return body.error;
}

const demoToken = () => fakeCookies.get(DEMO_COOKIE_NAME)?.value ?? null;

async function startDemo(): Promise<{ token: string; info: demoSchemas.DemoSessionInfo }> {
  const { session } = await ok<demoSchemas.StartDemoSessionResponse>(
    await startSession(post("/api/demo/session", { acknowledged: true }), noParams),
  );
  return { token: demoToken()!, info: session };
}

async function recordOnce(): Promise<demoSchemas.DemoRecordingResponse["recording"]> {
  const { recording } = await ok<demoSchemas.DemoRecordingResponse>(
    await uploadRecording(uploadRequest("/api/demo/recordings", { metadata: { captureMethod: "audio_worklet_pcm" } }), noParams),
  );
  return recording;
}

async function runAll(utteranceId: string, body: unknown = {}): Promise<demoSchemas.DemoResult> {
  const { result } = await ok<demoSchemas.RunDemoRecordingResponse>(
    await runRecording(post(`/api/demo/recordings/${utteranceId}/run`, body), withId(utteranceId)),
  );
  return result;
}

describe("access to Demo Mode", () => {
  it("needs an admin session while demoPublic is false", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const responses = [
      await getSession(get("/api/demo/session"), noParams),
      await startSession(post("/api/demo/session", { acknowledged: true }), noParams),
      await endSession(jsonRequest(`${BASE}/api/demo/session`, { method: "DELETE" }), noParams),
      await endByBeacon(post("/api/demo/session/end"), noParams),
      await uploadRecording(uploadRequest("/api/demo/recordings"), noParams),
      await runRecording(post(`/api/demo/recordings/${id}/run`), withId(id)),
      await media(get(`/api/demo/media/${id}`), withId(id)),
      await countLeftovers(get("/api/demo/purge-leftovers"), noParams),
      await purgeLeftovers(post("/api/demo/purge-leftovers", { confirm: true }), noParams),
    ];
    for (const response of responses) await fails(response, 401, "UNAUTHORIZED");
    expect(await harness.database.db.select().from(sessions).where(eq(sessions.studyId, studyId))).toHaveLength(0);
  });

  it("lets a signed-in researcher run a demo, with the mock option", async () => {
    await createAdminSession();
    const before = await ok<demoSchemas.DemoSessionResponse>(await getSession(get("/api/demo/session"), noParams));
    expect(before).toMatchObject({ session: null, access: { demoPublic: false, demoPersist: true, mockAvailable: true } });

    // Nothing is created before the recording notice is accepted.
    await fails(await startSession(post("/api/demo/session", {}), noParams), 400, "VALIDATION_ERROR");
    await fails(await startSession(post("/api/demo/session", { acknowledged: false }), noParams), 400, "VALIDATION_ERROR");
    expect(demoToken()).toBeNull();

    const { info } = await startDemo();
    const cookie = fakeCookies.lastWrite(DEMO_COOKIE_NAME)!;
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const [row] = await harness.database.db.select().from(sessions).where(eq(sessions.id, info.sessionId));
    expect(row!.mode).toBe("demo");

    const recording = await recordOnce();
    const result = await runAll(recording.utteranceId, { provider: "mock" });
    expect(result).toMatchObject({ ok: true, dataMode: "demo", providerMode: "mock", isMock: true });
    expect(result.conditions).toHaveLength(2);
    const [batch] = await harness.database.db
      .select()
      .from(processingBatches)
      .where(eq(processingBatches.id, result.processingBatchId!));
    expect(batch!.dataMode).toBe("demo");

    const after = await ok<demoSchemas.DemoSessionResponse>(await getSession(get("/api/demo/session"), noParams));
    expect(after.session).toMatchObject({ sessionId: info.sessionId, recordingCount: 1 });
  });

  it("lets a visitor in when demoPublic is true, without the mock option and without admin routes", async () => {
    await setSettings({ demoPublic: true });
    const access = await ok<demoSchemas.DemoSessionResponse>(await getSession(get("/api/demo/session"), noParams));
    expect(access.access).toMatchObject({ demoPublic: true, mockAvailable: false });

    await startDemo();
    const recording = await recordOnce();
    await fails(
      await runRecording(post(`/api/demo/recordings/${recording.utteranceId}/run`, { provider: "mock" }), withId(recording.utteranceId)),
      403,
      "FORBIDDEN",
    );
    const result = await runAll(recording.utteranceId, { stage: "asr" });
    expect(result.asr.status).toBe("succeeded");
    // A visitor never gets provider details.
    expect(JSON.stringify(result)).not.toContain('"detail"');

    await fails(await purgeLeftovers(post("/api/demo/purge-leftovers", { confirm: true }), noParams), 401, "UNAUTHORIZED");
    await fails(await runPipelineTest(post("/api/admin/ai/test", { source: "generated_tone" }), noParams), 401, "UNAUTHORIZED");
  });

  it("counts every pipeline request of a visitor against the hourly limit, not only the first stage", async () => {
    await setSettings({ demoPublic: true });
    await startDemo();
    const recording = await recordOnce();
    const hits = async () =>
      (await harness.database.db.select().from(rateLimitHits)).filter((row) => row.bucketKey.startsWith("demo-recording:")).length;
    expect(await hits()).toBe(1);
    await runAll(recording.utteranceId, { stage: "asr" });
    await runAll(recording.utteranceId, { stage: "translation" });
    await runAll(recording.utteranceId, { stage: "tts" });
    // One hit for the upload and one for each stage request.
    expect(await hits()).toBe(4);
    // A repeated stage request is counted too: it can be a new paid call.
    await runAll(recording.utteranceId, { stage: "translation" });
    expect(await hits()).toBe(5);

    // At the limit a translation or synthesis request is refused like any other.
    const [bucket] = (await harness.database.db.select().from(rateLimitHits)).filter((row) => row.bucketKey.startsWith("demo-recording:"));
    await harness.database.db
      .insert(rateLimitHits)
      .values(Array.from({ length: DEMO_RECORDING_LIMIT }, () => ({ bucketKey: bucket!.bucketKey, createdAt: harness.now })));
    for (const stage of ["translation", "tts", "asr", "all"]) {
      const response = await runRecording(post(`/api/demo/recordings/${recording.utteranceId}/run`, { stage }), withId(recording.utteranceId));
      await fails(response, 429, "RATE_LIMITED");
    }
  });

  it("rejects a state-changing request from another origin", async () => {
    await setSettings({ demoPublic: true });
    await fails(
      await startSession(post("/api/demo/session", { acknowledged: true }, { sameOrigin: false }), noParams),
      403,
      "FORBIDDEN",
    );
    const crossOrigin = new Request(`${BASE}/api/demo/session/end`, { method: "POST", headers: { origin: "https://example.org" } });
    await fails(await endByBeacon(crossOrigin, noParams), 403, "FORBIDDEN");
  });

  it("limits how many demo sessions one visitor address can start", async () => {
    await setSettings({ demoPublic: true });
    let last: Response | null = null;
    for (let index = 0; index < 31; index += 1) {
      last = await startSession(post("/api/demo/session", { acknowledged: true }), noParams);
    }
    await fails(last!, 429, "RATE_LIMITED");
  });

  it("does not accept the token of a research session as a demo session", async () => {
    await setSettings({ demoPublic: true });
    const research = await sessionService.createSession(getServiceContext(), { mode: "research" });
    fakeCookies.setRequestCookie(DEMO_COOKIE_NAME, research.token);
    const response = await ok<demoSchemas.DemoSessionResponse>(await getSession(get("/api/demo/session"), noParams));
    expect(response.session).toBeNull();
    fakeCookies.setRequestCookie(DEMO_COOKIE_NAME, research.token);
    await fails(await uploadRecording(uploadRequest("/api/demo/recordings"), noParams), 401, "SESSION_EXPIRED");
    expect(
      await harness.database.db.select().from(utterances).where(eq(utterances.sessionId, research.session.id)),
    ).toHaveLength(0);
  });
});

describe("demo audio", () => {
  it("is served to its own demo session only", async () => {
    await setSettings({ demoPublic: true });
    const first = await startDemo();
    const recording = await recordOnce();
    const result = await runAll(recording.utteranceId);
    const ttsId = result.conditions[0]!.synthesis.mediaAssetId!;

    const own = await media(get(`/api/demo/media/${ttsId}`), withId(ttsId));
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toContain("audio");
    expect(own.headers.get("cache-control")).toContain("no-store");
    expect((await own.arrayBuffer()).byteLength).toBeGreaterThan(44);
    const source = await media(get(`/api/demo/media/${recording.source.mediaAssetId}`), withId(recording.source.mediaAssetId));
    expect(source.status).toBe(200);
    const ranged = await media(
      new Request(`${BASE}/api/demo/media/${ttsId}`, { headers: { range: "bytes=0-9" } }),
      withId(ttsId),
    );
    expect(ranged.status).toBe(206);

    // A second visitor has another session and cannot fetch the first one's audio.
    fakeCookies.reset();
    const second = await startDemo();
    expect(second.token).not.toBe(first.token);
    await fails(await media(get(`/api/demo/media/${ttsId}`), withId(ttsId)), 404, "MEDIA_NOT_FOUND");
    await fails(
      await media(get(`/api/demo/media/${recording.source.mediaAssetId}`), withId(recording.source.mediaAssetId)),
      404,
      "MEDIA_NOT_FOUND",
    );
    // Nor run the first visitor's recording.
    await fails(
      await runRecording(post(`/api/demo/recordings/${recording.utteranceId}/run`), withId(recording.utteranceId)),
      404,
      "NOT_FOUND",
    );

    // Research audio is never served by the demo route.
    const research = await insertSessionWithUtterance(harness.database.db, { studyId, protocolVersionId: protocolId });
    await harness.storage.put({ key: research.media.storageKey, body: wav(), contentType: "audio/wav" });
    await fails(await media(get(`/api/demo/media/${research.media.id}`), withId(research.media.id)), 404, "MEDIA_NOT_FOUND");

    // Without a demo cookie there is nothing to serve, and a malformed id is refused.
    fakeCookies.reset();
    await fails(await media(get(`/api/demo/media/${ttsId}`), withId(ttsId)), 401, "SESSION_EXPIRED");
    fakeCookies.setRequestCookie(DEMO_COOKIE_NAME, first.token);
    await fails(await media(get("/api/demo/media/not-an-id"), withId("not-an-id")), 400, "VALIDATION_ERROR");
  });
});

describe("demo upload", () => {
  it("refuses an upload that is too large, too long, not audio or malformed, and stores nothing", async () => {
    await createAdminSession();
    // The limits of a demo recording are the study settings.
    await setSettings({ maxUploadMb: 2, maxUtteranceSeconds: 60 });
    const { info } = await startDemo();
    const cases: Array<[string, Request, number, string]> = [
      // Refused from the announced size alone, before the body is read.
      ["announced size", uploadRequest("/api/demo/recordings", { headers: { "content-length": String(50 * 1024 * 1024) } }), 413, "PAYLOAD_TOO_LARGE"],
      // 70 seconds of 16 kHz mono is 2.2 MB: above the study limit of 2 MB.
      ["real size", uploadRequest("/api/demo/recordings", { data: wav(70_000) }), 413, "PAYLOAD_TOO_LARGE"],
      // 80 seconds at 8 kHz is small, and longer than the 60 seconds the study allows.
      ["too long", uploadRequest("/api/demo/recordings", { data: generateSineWav({ durationMs: 80_000, sampleRateHz: 8000, frequencyHz: 300 }) }), 422, "INVALID_AUDIO"],
      ["not audio", uploadRequest("/api/demo/recordings", { data: Buffer.from("plain text, not audio. ".repeat(40)) }), 422, "INVALID_AUDIO"],
      ["missing file part", uploadRequest("/api/demo/recordings", { partName: "file" }), 400, "VALIDATION_ERROR"],
      ["unknown metadata field", uploadRequest("/api/demo/recordings", { metadata: { transcript: "x" } }), 400, "VALIDATION_ERROR"],
      ["not multipart", post("/api/demo/recordings", { audio: "x" }), 400, "VALIDATION_ERROR"],
    ];
    for (const [name, request, status, code] of cases) {
      const error = await fails(await uploadRecording(request, noParams), status, code);
      expect(error.message, name).not.toMatch(/ffprobe|\/tmp|\bat \b|Error:/);
      if (code === "PAYLOAD_TOO_LARGE") expect(error.message, name).toContain("2 MB");
    }
    expect(await harness.database.db.select().from(utterances).where(eq(utterances.sessionId, info.sessionId))).toHaveLength(0);
    expect(await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, info.sessionId))).toHaveLength(0);
    expect(harness.storage.keys()).toEqual([]);
  });

  it("accepts a recording above 10 MB and above one minute when the study settings allow it", async () => {
    await createAdminSession();
    await setSettings({ maxUploadMb: 20, maxUtteranceSeconds: 400 });
    await startDemo();
    // 340 seconds of 16 kHz, 16 bit, mono is 10.9 MB.
    const data = wav(340_000);
    expect(data.length).toBeGreaterThan(10 * 1024 * 1024);
    const stored = await ok<demoSchemas.DemoRecordingResponse>(
      await uploadRecording(uploadRequest("/api/demo/recordings", { data }), noParams),
    );
    const [asset] = await harness.database.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.utteranceId, stored.recording.utteranceId));
    expect(asset!.sizeBytes).toBe(data.length);
    expect(asset!.durationMs).toBe(340_000);
  });
});

describe("ending a demo session", () => {
  it("keeps the data when demoPersist is true", async () => {
    await createAdminSession();
    const { info } = await startDemo();
    const recording = await recordOnce();
    await runAll(recording.utteranceId);

    const ended = await ok<demoSchemas.EndDemoSessionResponse>(
      await endSession(jsonRequest(`${BASE}/api/demo/session`, { method: "DELETE" }), noParams),
    );
    expect(ended).toEqual({ ended: true, purged: false });
    expect(demoToken()).toBeNull();
    const [row] = await harness.database.db.select().from(sessions).where(eq(sessions.id, info.sessionId));
    expect(row).toMatchObject({ mode: "demo", status: "completed" });
    expect(await harness.database.db.select().from(utterances).where(eq(utterances.sessionId, info.sessionId))).toHaveLength(1);
    // Leftovers are only removed this way while demo data is not kept.
    await fails(await purgeLeftovers(post("/api/demo/purge-leftovers", { confirm: true }), noParams), 409, "INVALID_STATE");
  });

  it("deletes the data when demoPersist is false, also through the beacon route", async () => {
    await setSettings({ demoPersist: false });
    await createAdminSession();
    const { info } = await startDemo();
    const recording = await recordOnce();
    const result = await runAll(recording.utteranceId);
    expect(harness.storage.keys().length).toBe(3);

    const ended = await ok<demoSchemas.EndDemoSessionResponse>(await endByBeacon(post("/api/demo/session/end"), noParams));
    expect(ended).toEqual({ ended: true, purged: true });
    expect(await harness.database.db.select().from(sessions).where(eq(sessions.id, info.sessionId))).toHaveLength(0);
    expect(
      await harness.database.db.select().from(processingBatches).where(eq(processingBatches.id, result.processingBatchId!)),
    ).toHaveLength(0);
    expect(harness.storage.keys()).toEqual([]);
    const audit = await harness.database.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, info.sessionId));
    expect(audit.map((entry) => entry.action)).toEqual(["test_data.reset"]);

    // A second call finds nothing to end.
    expect(await ok<demoSchemas.EndDemoSessionResponse>(await endByBeacon(post("/api/demo/session/end"), noParams))).toEqual({
      ended: false,
      purged: false,
    });
    const leftovers = await ok<{ sessions: number }>(await countLeftovers(get("/api/demo/purge-leftovers"), noParams));
    expect(typeof leftovers.sessions).toBe("number");
    await fails(await purgeLeftovers(post("/api/demo/purge-leftovers", {}), noParams), 400, "VALIDATION_ERROR");
    await ok<demoSchemas.PurgeLeftoversResponse>(await purgeLeftovers(post("/api/demo/purge-leftovers", { confirm: true }), noParams));
  });
});

describe("/api/admin/ai/test", () => {
  it("refuses a clip that is longer than 30 seconds or larger than 9 MB", async () => {
    await createAdminSession();
    const before = await harness.database.db.select().from(sessions).where(eq(sessions.studyId, studyId));
    // 40 seconds at 8 kHz is small, and longer than a pipeline test clip may be.
    const long = generateSineWav({ durationMs: 40_000, sampleRateHz: 8000, frequencyHz: 300 });
    await fails(await runPipelineTest(uploadRequest("/api/admin/ai/test", { data: long }), noParams), 422, "INVALID_AUDIO");
    const large = await fails(
      await runPipelineTest(uploadRequest("/api/admin/ai/test", { headers: { "content-length": String(10 * 1024 * 1024) } }), noParams),
      413,
      "PAYLOAD_TOO_LARGE",
    );
    expect(large.message).toContain("9 MB");
    expect(await harness.database.db.select().from(sessions).where(eq(sessions.studyId, studyId))).toHaveLength(before.length);
  });

  // The route is not matched by the proxy (proxy.ts), so this check is the only gate.
  it("requires an admin session", async () => {
    await fails(await lastPipelineTest(get("/api/admin/ai/test"), noParams), 401, "UNAUTHORIZED");
    await fails(await runPipelineTest(post("/api/admin/ai/test", { source: "generated_tone" }), noParams), 401, "UNAUTHORIZED");
    await fails(await runPipelineTest(uploadRequest("/api/admin/ai/test"), noParams), 401, "UNAUTHORIZED");
  });

  it("runs with the generated tone and with a recorded clip, writes test data and remembers the last result", async () => {
    await createAdminSession();
    const tone = await ok<demoSchemas.PipelineTestResponse>(
      await runPipelineTest(post("/api/admin/ai/test", { source: "generated_tone" }), noParams),
    );
    expect(tone.result.rows.map((row) => `${row.label}: ${row.result}`)).toEqual([
      "ASR: PASS",
      "Default translation: PASS",
      "Preserve translation: PASS",
      "TTS: PASS",
      "Storage: PASS",
    ]);
    expect(tone.result).toMatchObject({ passed: true, dataMode: "test", source: "generated_tone", providerMode: "active" });
    const [session] = await harness.database.db.select().from(sessions).where(eq(sessions.id, tone.result.sessionId));
    expect(session!.mode).toBe("test");

    const clip = await ok<demoSchemas.PipelineTestResponse>(
      await runPipelineTest(uploadRequest("/api/admin/ai/test", { options: { provider: "mock" } }), noParams),
    );
    expect(clip.result).toMatchObject({ passed: true, source: "recording", providerMode: "mock", isMock: true });

    const last = await ok<demoSchemas.LastPipelineTestResponse>(await lastPipelineTest(get("/api/admin/ai/test"), noParams));
    expect(last.mockAvailable).toBe(true);
    expect(last.last?.sessionId).toBe(clip.result.sessionId);
    const audit = await harness.database.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, "pipeline_test.run"));
    expect(audit.map((entry) => entry.entityId).sort()).toEqual([tone.result.sessionId, clip.result.sessionId].sort());
    expect(audit.every((entry) => entry.actorLabel === "admin")).toBe(true);
  });

  it("refuses a bad request and an oversized or unusable clip", async () => {
    await createAdminSession();
    await fails(await runPipelineTest(post("/api/admin/ai/test", { source: "microphone" }), noParams), 400, "VALIDATION_ERROR");
    await fails(
      await runPipelineTest(post("/api/admin/ai/test", { source: "generated_tone", provider: "openai" }), noParams),
      400,
      "VALIDATION_ERROR",
    );
    await fails(
      await runPipelineTest(post("/api/admin/ai/test", { source: "generated_tone" }, { sameOrigin: false }), noParams),
      403,
      "FORBIDDEN",
    );
    const before = await harness.database.db.select().from(sessions).where(eq(sessions.studyId, studyId));
    await fails(
      await runPipelineTest(
        uploadRequest("/api/admin/ai/test", { headers: { "content-length": String(50 * 1024 * 1024) } }),
        noParams,
      ),
      413,
      "PAYLOAD_TOO_LARGE",
    );
    await fails(
      await runPipelineTest(uploadRequest("/api/admin/ai/test", { data: Buffer.from("not audio ".repeat(100)) }), noParams),
      422,
      "INVALID_AUDIO",
    );
    expect(await harness.database.db.select().from(sessions).where(eq(sessions.studyId, studyId))).toHaveLength(before.length);
  });
});
