// Route tests of the participant API. The handlers are called directly with the
// in-memory cookie store of the server test setup (lib/server/test).
import { asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  jobs,
  mediaAssets,
  questionnaireResponses,
  rateLimitHits,
  sessionConsents,
  sessions,
  studies,
  utterances,
  type StudySettings,
} from "@dialect/db";
import {
  DEFAULT_TEST_CONSENT_ITEMS,
  insertActiveAiConfigs,
  insertConsentVersion,
  insertPublishedProtocol,
  insertQuestionnaire,
  insertStudy,
} from "@dialect/db/testing-builders";
import { CONSENT_SCOPE_EXTERNAL_AI_PROCESSING, type sessionSchemas } from "@dialect/domain";
import { generateSineWav } from "@dialect/storage";
import { createAdminSession } from "@/lib/server/admin-auth";
import { resetEnvCacheForTests } from "@/lib/server/env";
import { hashParticipantToken, PARTICIPANT_COOKIE_NAME } from "@/lib/server/participant-cookie";
import { clientAddressKey } from "@/lib/server/rate-limit";
import { jsonRequest, noParams, setupServerTestHarness } from "@/lib/server/test/database";
import { fakeCookies } from "@/lib/server/test/request-scope";
import { applyTestEnv } from "@/lib/server/test/setup";
import { SESSION_CREATE_LIMIT } from "./_lib/participant";
import { POST as consentRoute } from "./consent/route";
import { GET as infoRoute } from "./info/route";
import { POST as instructionsRoute } from "./instructions/route";
import { POST as micCheckRoute } from "./mic-check/route";
import { GET as nextTaskRoute } from "./next-task/route";
import { POST as questionnaireRoute } from "./questionnaires/[key]/route";
import { POST as completeRoute } from "./session/complete/route";
import { POST as localeRoute } from "./session/locale/route";
import { GET as sessionRoute } from "./session/route";
import { POST as withdrawRoute } from "./session/withdraw/route";
import { POST as sessionsRoute } from "./sessions/route";
import { POST as startRoute } from "./tasks/[presentationId]/start/route";
import { DELETE as discardRoute, POST as audioRoute } from "./utterances/[id]/audio/route";
import { POST as skipRoute } from "./utterances/[id]/skip/route";
import { POST as submitRoute } from "./utterances/[id]/submit/route";
import { POST as utterancesRoute } from "./utterances/route";

type State = sessionSchemas.ParticipantState;
type TasksState = Extract<State, { step: "tasks" }>;

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const BASE_SETTINGS: StudySettings = {
  allowNewSessions: true,
  autoQueueAsr: true,
  maxUploadMb: 1,
  maxUtteranceSeconds: 60,
  studyLaptopMode: true,
  participantLocales: ["fi", "en"],
  defaultLocale: "fi",
};

let studyId: string;
let protocolId: string;

beforeAll(async () => {
  const db = harness.database.db;
  // The first study of the database is the one the routes use.
  const study = await insertStudy(db, { name: "Route test study", settingsJson: BASE_SETTINGS });
  studyId = study.id;
  const background = await insertQuestionnaire(db, {
    studyId,
    key: "background",
    items: [{ itemKey: "region", type: "short_text", prompt: "Where did you grow up?", required: true }],
  });
  const post = await insertQuestionnaire(db, {
    studyId,
    key: "post_recording",
    items: [{ itemKey: "naturalness", type: "likert", prompt: "How naturally?", required: true, configJson: { scaleMin: 1, scaleMax: 5 } }],
  });
  // Automatic transcription after an upload needs two things: an accepted consent
  // item with the scope external_ai_processing, and an active asr_default configuration.
  const consent = await insertConsentVersion(db, {
    studyId,
    itemsJson: [
      ...DEFAULT_TEST_CONSENT_ITEMS,
      {
        id: "external_ai_processing",
        text: "My recordings may be processed with external AI services.",
        required: false,
        scope: CONSENT_SCOPE_EXTERNAL_AI_PROCESSING,
      },
    ],
  });
  await insertActiveAiConfigs(db, { studyId });
  const bundle = await insertPublishedProtocol(db, {
    studyId,
    consentVersionId: consent.id,
    backgroundQuestionnaireVersionId: background.version.id,
    postQuestionnaireVersionId: post.version.id,
    tasks: [
      { taskKey: "controlled", taskType: "controlled", title: "Controlled", participantPrompt: "Controlled prompt.", maxDurationSeconds: 5 },
      {
        taskKey: "semi",
        taskType: "semi_structured",
        title: "Semi-structured",
        participantPrompt: "Semi-structured prompt.",
        followups: [
          { followupKey: "required", promptText: "Required follow-up.", isRequired: true },
          { followupKey: "optional", promptText: "Optional follow-up.", isRequired: false },
        ],
      },
      { taskKey: "free", taskType: "free_speech", title: "Free speech", participantPrompt: "Free speech prompt.", privacyReminder: true },
    ],
  });
  protocolId = bundle.protocol.id;
});

beforeEach(async () => {
  const db = harness.database.db;
  await db.update(studies).set({ settingsJson: BASE_SETTINGS, status: "active" }).where(eq(studies.id, studyId));
  await db.delete(rateLimitHits);
});

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const post = (path: string, body?: unknown, headers?: Record<string, string>) =>
  jsonRequest(`${BASE}${path}`, { body, headers });
const get = (path: string) => new Request(`${BASE}${path}`, { method: "GET" });
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

function audioRequest(
  id: string,
  options: { data?: Buffer; type?: string; metadata?: unknown; headers?: Record<string, string>; partName?: string } = {},
): Request {
  const form = new FormData();
  const data = options.data ?? wav();
  form.set(options.partName ?? "audio", new Blob([new Uint8Array(data)], { type: options.type ?? "audio/wav" }), "recording.wav");
  if (options.metadata !== undefined) {
    form.set("metadata", typeof options.metadata === "string" ? options.metadata : JSON.stringify(options.metadata));
  }
  return new Request(`${BASE}/api/study/utterances/${id}/audio`, {
    method: "POST",
    body: form,
    headers: { origin: BASE, "user-agent": "RouteTest/1.0", ...options.headers },
  });
}

const wav = (durationMs = 300) => generateSineWav({ durationMs, sampleRateHz: 16000, frequencyHz: 440 });

async function ok<T>(response: Response): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as T;
}

async function fails(response: Response, status: number, code: string): Promise<{ code: string; message: string; details?: unknown }> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  return body.error;
}

const cookieToken = () => fakeCookies.get(PARTICIPANT_COOKIE_NAME)?.value ?? null;
const useCookie = (token: string) => fakeCookies.setRequestCookie(PARTICIPANT_COOKIE_NAME, token);

async function startSession(body: sessionSchemas.CreateSessionBody = {}): Promise<{ state: State; token: string }> {
  const { state } = await ok<sessionSchemas.CreateSessionResponse>(await sessionsRoute(post("/api/study/sessions", body), noParams));
  return { state, token: cookieToken()! };
}

async function sessionRowOf(token: string) {
  const [row] = await harness.database.db.select().from(sessions).where(eq(sessions.tokenHash, hashParticipantToken(token)));
  return row!;
}

function acceptAll(state: State) {
  if (state.step !== "consent") throw new Error(`expected the consent step, got ${state.step}`);
  return { responses: state.consent.items.map((item) => ({ itemId: item.id, accepted: true })) };
}

// Creates a session and walks it to the first task through the routes.
async function atTasks(): Promise<{ state: TasksState; token: string }> {
  const { state, token } = await startSession();
  await ok(await consentRoute(post("/api/study/consent", acceptAll(state)), noParams));
  await ok(await micCheckRoute(post("/api/study/mic-check", {}), noParams));
  const { state: tasks } = await ok<sessionSchemas.StateResponse>(await instructionsRoute(post("/api/study/instructions"), noParams));
  if (tasks.step !== "tasks") throw new Error(`expected the tasks step, got ${tasks.step}`);
  return { state: tasks, token };
}

// Start the task if needed and create the utterance of the current turn.
async function openTurn(state: TasksState): Promise<string> {
  if (state.task.status === "pending") {
    await ok(
      await startRoute(post(`/api/study/tasks/${state.task.presentationId}/start`), {
        params: Promise.resolve({ presentationId: state.task.presentationId }),
      }),
    );
  }
  const { utteranceId } = await ok<sessionSchemas.CreateUtteranceResponse>(
    await utterancesRoute(
      post("/api/study/utterances", { presentationId: state.task.presentationId, turnIndex: state.task.turn.turnIndex }),
      noParams,
    ),
  );
  return utteranceId;
}

async function answerTurn(state: TasksState, attemptCount = 1): Promise<{ state: State; utteranceId: string; mediaAssetId: string }> {
  const utteranceId = await openTurn(state);
  const upload = await ok<sessionSchemas.UploadAudioResponse>(await audioRoute(audioRequest(utteranceId), withId(utteranceId)));
  const { state: next } = await ok<sessionSchemas.StateResponse>(
    await submitRoute(post(`/api/study/utterances/${utteranceId}/submit`, { mediaAssetId: upload.mediaAssetId, attemptCount }), withId(utteranceId)),
  );
  return { state: next, utteranceId, mediaAssetId: upload.mediaAssetId };
}

// ---------------------------------------------------------------------------

describe("GET /api/study/info", () => {
  it("describes the open study without a session", async () => {
    const response = await infoRoute(get("/api/study/info"), noParams);
    expect(await ok(response)).toEqual({
      // The neutral participant title, never the internal study name.
      studyName: "Research study",
      acceptingNewSessions: true,
      closedReason: null,
      closedMessage: null,
      welcomeContent: "Test welcome text.",
      studyNameByLocale: { fi: "Tutkimus", en: "Research study" },
      welcomeContentByLocale: { fi: "Test welcome text.", en: "Test welcome text." },
      locales: ["fi", "en"],
      defaultLocale: "fi",
      studyLaptopMode: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cookieToken()).toBeNull();
  });

  it("says that the study takes no new participants when it is closed", async () => {
    await harness.database.db
      .update(studies)
      .set({ settingsJson: { ...BASE_SETTINGS, allowNewSessions: false } })
      .where(eq(studies.id, studyId));
    const info = await ok<sessionSchemas.StudyInfoResponse>(await infoRoute(get("/api/study/info"), noParams));
    expect(info).toMatchObject({
      acceptingNewSessions: false,
      closedReason: "new_sessions_disabled",
      closedMessage: "This study is not currently accepting new participants.",
    });
    const error = await fails(await sessionsRoute(post("/api/study/sessions", {}), noParams), 403, "STUDY_CLOSED");
    expect(error.message).toBe("This study is not currently accepting new participants.");
    expect(cookieToken()).toBeNull();
  });
});

describe("POST /api/study/sessions", () => {
  it("creates a research session and sets an HttpOnly cookie that holds only the opaque token", async () => {
    const response = await sessionsRoute(post("/api/study/sessions", { locale: "en", browserInfo: { userAgent: "RouteTest/1.0" } }), noParams);
    const body = await ok<sessionSchemas.CreateSessionResponse>(response);
    expect(body.resumed).toBe(false);
    expect(body.state.step).toBe("consent");
    expect(body.state.mode).toBe("research");
    expect(body.state.locale).toBe("en");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const write = fakeCookies.lastWrite(PARTICIPANT_COOKIE_NAME)!;
    expect(write.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await sessionRowOf(write.value);
    expect(write.options).toEqual({ httpOnly: true, sameSite: "lax", secure: false, path: "/", expires: row.tokenExpiresAt });
    expect(row.tokenExpiresAt!.getTime()).toBe(harness.now.getTime() + 24 * 3600 * 1000);
    expect(row.protocolVersionId).toBe(protocolId);
    expect(row.mode).toBe("research");
    // Neither the token nor the internal session id is in the response or the database row.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(write.value);
    expect(serialized).not.toContain(row.id);
    expect(JSON.stringify(row)).not.toContain(write.value);
    expect(body.state.participantCode).toBe(row.participantCode);
  });

  it("marks the cookie Secure in production", async () => {
    applyTestEnv({ NODE_ENV: "production" });
    resetEnvCacheForTests();
    await startSession();
    expect(fakeCookies.lastWrite(PARTICIPANT_COOKIE_NAME)!.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  });

  it("returns the running session instead of creating a new one (page reload), unless restart is true", async () => {
    const first = await startSession();
    await ok(await consentRoute(post("/api/study/consent", acceptAll(first.state)), noParams));
    const before = (await harness.database.db.select().from(sessions)).length;

    const again = await ok<sessionSchemas.CreateSessionResponse>(await sessionsRoute(post("/api/study/sessions", {}), noParams));
    expect(again.resumed).toBe(true);
    expect(again.state.step).toBe("mic_check");
    expect(again.state.participantCode).toBe(first.state.participantCode);
    expect(cookieToken()).toBe(first.token);
    expect((await harness.database.db.select().from(sessions)).length).toBe(before);

    // Study laptop: "Start next participant".
    const next = await ok<sessionSchemas.CreateSessionResponse>(await sessionsRoute(post("/api/study/sessions", { restart: true }), noParams));
    expect(next.resumed).toBe(false);
    expect(next.state.step).toBe("consent");
    expect(next.state.participantCode).not.toBe(first.state.participantCode);
    expect(cookieToken()).not.toBe(first.token);
    expect((await harness.database.db.select().from(sessions)).length).toBe(before + 1);
  });

  it("creates a new session when the cookie belongs to a finished session", async () => {
    const first = await startSession();
    await ok(await withdrawRoute(post("/api/study/session/withdraw"), noParams));
    useCookie(first.token);
    const next = await ok<sessionSchemas.CreateSessionResponse>(await sessionsRoute(post("/api/study/sessions", {}), noParams));
    expect(next.resumed).toBe(false);
    expect(next.state.participantCode).not.toBe(first.state.participantCode);
  });

  it("honors mode test only for a signed-in admin", async () => {
    await fails(await sessionsRoute(post("/api/study/sessions", { mode: "test" }), noParams), 403, "FORBIDDEN");
    await fails(await sessionsRoute(post("/api/study/sessions", { mode: "demo" }), noParams), 403, "FORBIDDEN");
    expect(cookieToken()).toBeNull();
    await createAdminSession();
    const { state, token } = await startSession({ mode: "test" });
    expect(state.mode).toBe("test");
    expect((await sessionRowOf(token)).mode).toBe("test");
  });

  it("rejects a request from another origin and unknown body fields", async () => {
    await fails(
      await sessionsRoute(jsonRequest(`${BASE}/api/study/sessions`, { body: {}, headers: { origin: "https://evil.example" } }), noParams),
      403,
      "FORBIDDEN",
    );
    await fails(await sessionsRoute(jsonRequest(`${BASE}/api/study/sessions`, { body: {}, sameOrigin: false }), noParams), 403, "FORBIDDEN");
    await fails(await sessionsRoute(post("/api/study/sessions", { sessionId: UNKNOWN_ID }), noParams), 400, "VALIDATION_ERROR");
    expect((await harness.database.db.select().from(rateLimitHits)).length).toBe(0);
  });

  it("limits session creation per client address, and a resume does not count", async () => {
    const request = post("/api/study/sessions", {});
    const bucket = `session-create:${clientAddressKey(request)}`;
    await harness.database.db
      .insert(rateLimitHits)
      .values(Array.from({ length: SESSION_CREATE_LIMIT - 1 }, () => ({ bucketKey: bucket, createdAt: harness.now })));
    const { token } = await startSession();
    // The running session is returned without a new hit.
    await ok(await sessionsRoute(post("/api/study/sessions", {}), noParams));
    expect((await harness.database.db.select().from(rateLimitHits)).length).toBe(SESSION_CREATE_LIMIT);

    const response = await sessionsRoute(post("/api/study/sessions", { restart: true }), noParams);
    await fails(response, 429, "RATE_LIMITED");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    // The stored bucket key does not contain an address.
    expect(bucket).toMatch(/^session-create:[0-9a-f]{32}$/);

    // After the window the limit is free again.
    harness.advanceSeconds(3601);
    await ok(await sessionsRoute(post("/api/study/sessions", { restart: true }), noParams));
    expect(cookieToken()).not.toBe(token);
  });
});

describe("the session is identified only by the cookie", () => {
  it("answers 401 SESSION_EXPIRED on every endpoint without a cookie, and GET /session gives null", async () => {
    const id = withId(UNKNOWN_ID);
    const calls: Array<() => Promise<Response>> = [
      () => consentRoute(post("/api/study/consent", { responses: [] }), noParams),
      () => micCheckRoute(post("/api/study/mic-check", {}), noParams),
      () => instructionsRoute(post("/api/study/instructions"), noParams),
      () => nextTaskRoute(get("/api/study/next-task"), noParams),
      () => startRoute(post(`/api/study/tasks/${UNKNOWN_ID}/start`), { params: Promise.resolve({ presentationId: UNKNOWN_ID }) }),
      () => utterancesRoute(post("/api/study/utterances", { presentationId: UNKNOWN_ID, turnIndex: 0 }), noParams),
      () => audioRoute(audioRequest(UNKNOWN_ID), id),
      () => discardRoute(jsonRequest(`${BASE}/api/study/utterances/${UNKNOWN_ID}/audio`, { method: "DELETE" }), id),
      () => submitRoute(post(`/api/study/utterances/${UNKNOWN_ID}/submit`, { mediaAssetId: UNKNOWN_ID }), id),
      () => skipRoute(post(`/api/study/utterances/${UNKNOWN_ID}/skip`), id),
      () => questionnaireRoute(post("/api/study/questionnaires/background", { answers: {} }), { params: Promise.resolve({ key: "background" }) }),
      () => completeRoute(post("/api/study/session/complete"), noParams),
      () => withdrawRoute(post("/api/study/session/withdraw"), noParams),
    ];
    for (const call of calls) await fails(await call(), 401, "SESSION_EXPIRED");
    expect(await ok(await sessionRoute(get("/api/study/session"), noParams))).toEqual({ state: null });
    // A value that is not a token is treated like no cookie.
    useCookie("not-a-token");
    expect(await ok(await sessionRoute(get("/api/study/session"), noParams))).toEqual({ state: null });
  });

  it("ignores a session id in the query string and refuses one in the body", async () => {
    const other = await startSession();
    const otherRow = await sessionRowOf(other.token);
    const mine = await startSession({ restart: true });
    const viaQuery = await ok<sessionSchemas.SessionResponse>(
      await sessionRoute(get(`/api/study/session?sessionId=${otherRow.id}&participantCode=${otherRow.participantCode}`), noParams),
    );
    expect(viaQuery.state?.participantCode).toBe(mine.state.participantCode);
    await fails(
      await consentRoute(post("/api/study/consent", { ...acceptAll(mine.state), sessionId: otherRow.id }), noParams),
      400,
      "VALIDATION_ERROR",
    );
    expect(await harness.database.db.select().from(sessionConsents).where(eq(sessionConsents.sessionId, otherRow.id))).toHaveLength(0);
  });

  it("treats an expired token as no session and clears the cookie", async () => {
    const { state } = await startSession();
    harness.advanceSeconds(24 * 3600 + 1);
    await fails(await consentRoute(post("/api/study/consent", acceptAll(state)), noParams), 401, "SESSION_EXPIRED");
    expect(await ok(await sessionRoute(get("/api/study/session"), noParams))).toEqual({ state: null });
    expect(fakeCookies.lastWrite(PARTICIPANT_COOKIE_NAME)).toMatchObject({ value: "", options: { maxAge: 0, httpOnly: true } });
    expect(cookieToken()).toBeNull();
  });

  it("does not let a participant touch another session's task, utterance or recording", async () => {
    const other = await atTasks();
    const otherUtterance = await openTurn(other.state);
    const otherUpload = await ok<sessionSchemas.UploadAudioResponse>(await audioRoute(audioRequest(otherUtterance), withId(otherUtterance)));

    const mine = await (async () => {
      await startSession({ restart: true });
      const state = (await ok<sessionSchemas.SessionResponse>(await sessionRoute(get("/api/study/session"), noParams))).state!;
      await ok(await consentRoute(post("/api/study/consent", acceptAll(state)), noParams));
      await ok(await micCheckRoute(post("/api/study/mic-check", {}), noParams));
      const { state: tasks } = await ok<sessionSchemas.StateResponse>(await instructionsRoute(post("/api/study/instructions"), noParams));
      return tasks as TasksState;
    })();
    const myUtterance = await openTurn(mine);

    const otherPresentation = { params: Promise.resolve({ presentationId: other.state.task.presentationId }) };
    await fails(await startRoute(post(`/api/study/tasks/${other.state.task.presentationId}/start`), otherPresentation), 404, "NOT_FOUND");
    await fails(
      await utterancesRoute(post("/api/study/utterances", { presentationId: other.state.task.presentationId, turnIndex: 0 }), noParams),
      404,
      "NOT_FOUND",
    );
    await fails(await audioRoute(audioRequest(otherUtterance), withId(otherUtterance)), 404, "NOT_FOUND");
    await fails(
      await discardRoute(jsonRequest(`${BASE}/api/study/utterances/${otherUtterance}/audio`, { method: "DELETE" }), withId(otherUtterance)),
      404,
      "NOT_FOUND",
    );
    await fails(await skipRoute(post(`/api/study/utterances/${otherUtterance}/skip`), withId(otherUtterance)), 404, "NOT_FOUND");
    await fails(
      await submitRoute(post(`/api/study/utterances/${otherUtterance}/submit`, { mediaAssetId: otherUpload.mediaAssetId }), withId(otherUtterance)),
      404,
      "NOT_FOUND",
    );
    // My utterance with the other session's recording.
    await fails(
      await submitRoute(post(`/api/study/utterances/${myUtterance}/submit`, { mediaAssetId: otherUpload.mediaAssetId }), withId(myUtterance)),
      404,
      "MEDIA_NOT_FOUND",
    );
    // The other session's data are unchanged.
    const [row] = await harness.database.db.select().from(utterances).where(eq(utterances.id, otherUtterance));
    expect(row).toMatchObject({ status: "uploading", acceptedMediaAssetId: null });
    expect(await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.id, otherUpload.mediaAssetId))).toHaveLength(1);
  });
});

describe("consent comes first", () => {
  it("rejects every later endpoint for a session without stored consent", async () => {
    const { state, token } = await startSession();
    const id = withId(UNKNOWN_ID);
    await fails(await micCheckRoute(post("/api/study/mic-check", {}), noParams), 409, "INVALID_STATE");
    await fails(await instructionsRoute(post("/api/study/instructions"), noParams), 409, "INVALID_STATE");
    await fails(
      await startRoute(post(`/api/study/tasks/${UNKNOWN_ID}/start`), { params: Promise.resolve({ presentationId: UNKNOWN_ID }) }),
      409,
      "INVALID_STATE",
    );
    await fails(await utterancesRoute(post("/api/study/utterances", { presentationId: UNKNOWN_ID, turnIndex: 0 }), noParams), 409, "INVALID_STATE");
    await fails(await audioRoute(audioRequest(UNKNOWN_ID), id), 404, "NOT_FOUND");
    await fails(await submitRoute(post(`/api/study/utterances/${UNKNOWN_ID}/submit`, { mediaAssetId: UNKNOWN_ID }), id), 404, "NOT_FOUND");
    await fails(await skipRoute(post(`/api/study/utterances/${UNKNOWN_ID}/skip`), id), 409, "INVALID_STATE");
    await fails(
      await questionnaireRoute(post("/api/study/questionnaires/background", { answers: { region: "Oulu" } }), { params: Promise.resolve({ key: "background" }) }),
      409,
      "INVALID_STATE",
    );
    await fails(await completeRoute(post("/api/study/session/complete"), noParams), 409, "INVALID_STATE");
    const next = await ok<sessionSchemas.NextTaskResponse>(await nextTaskRoute(get("/api/study/next-task"), noParams));
    expect(next).toEqual({ step: "consent", progress: null, task: null });

    // A refused required item stores nothing, and the state still asks for consent.
    const refused = await fails(
      await consentRoute(
        post("/api/study/consent", {
          responses: (state as Extract<State, { step: "consent" }>).consent.items.map((item, index) => ({ itemId: item.id, accepted: index !== 0 })),
        }),
        noParams,
      ),
      400,
      "VALIDATION_ERROR",
    );
    expect(refused.details).toMatchObject({ reason: "required_consent_not_accepted" });
    const row = await sessionRowOf(token);
    expect(row.status).toBe("created");
    expect(row.consentedAt).toBeNull();
    expect(await harness.database.db.select().from(sessionConsents).where(eq(sessionConsents.sessionId, row.id))).toHaveLength(0);
    const after = await ok<sessionSchemas.SessionResponse>(await sessionRoute(get("/api/study/session"), noParams));
    expect(after.state?.step).toBe("consent");
  });

  it("the microphone check endpoint takes settings only: an audio field is refused", async () => {
    const { state } = await startSession();
    await ok(await consentRoute(post("/api/study/consent", acceptAll(state)), noParams));
    await fails(await micCheckRoute(post("/api/study/mic-check", { audio: "UklGRg==" }), noParams), 400, "VALIDATION_ERROR");
    await fails(
      await micCheckRoute(post("/api/study/mic-check", { audioEnvironment: { recording: "UklGRg==" } }), noParams),
      400,
      "VALIDATION_ERROR",
    );
    const { state: next } = await ok<sessionSchemas.StateResponse>(
      await micCheckRoute(
        post("/api/study/mic-check", { audioEnvironment: { deviceLabel: "Built-in", audioContextSampleRate: 48000, actualTrackSettings: { channelCount: 1 } } }),
        noParams,
      ),
    );
    expect(next.step).toBe("instructions");
    expect(harness.storage.keys()).toHaveLength(0);
  });
});

describe("a whole session through the API", () => {
  it("runs from the first request to completion, survives reloads and leaves nothing for the next participant", async () => {
    const { state: consentState, token } = await startSession({ locale: "fi" });
    const row = await sessionRowOf(token);
    const reload = async (expected: State) => {
      const body = await ok<sessionSchemas.SessionResponse>(await sessionRoute(get("/api/study/session"), noParams));
      expect(body.state).toEqual(expected);
    };
    await reload(consentState);

    let state = (await ok<sessionSchemas.StateResponse>(await consentRoute(post("/api/study/consent", acceptAll(consentState)), noParams))).state;
    expect(state.step).toBe("mic_check");
    await reload(state);
    state = (await ok<sessionSchemas.StateResponse>(await micCheckRoute(post("/api/study/mic-check", {}), noParams))).state;
    expect(state.step).toBe("instructions");
    state = (await ok<sessionSchemas.StateResponse>(await instructionsRoute(post("/api/study/instructions"), noParams))).state;
    await reload(state);

    const seen: string[] = [];
    for (let guard = 0; state.step === "tasks" && guard < 20; guard += 1) {
      seen.push(`${state.task.taskType}:${state.task.turn.turnIndex}`);
      const next = await ok<sessionSchemas.NextTaskResponse>(await nextTaskRoute(get("/api/study/next-task"), noParams));
      expect(next.task).toEqual(state.task);
      if (state.task.turn.isOptional) {
        const utteranceId = await openTurn(state);
        state = (await ok<sessionSchemas.StateResponse>(await skipRoute(post(`/api/study/utterances/${utteranceId}/skip`), withId(utteranceId)))).state;
      } else {
        state = (await answerTurn(state, 2)).state;
      }
      await reload(state);
    }
    expect(seen).toEqual(["controlled:0", "semi_structured:0", "semi_structured:1", "semi_structured:2", "free_speech:0"]);
    const stored = await harness.database.db.select().from(utterances).where(eq(utterances.sessionId, row.id)).orderBy(asc(utterances.createdAt));
    expect(stored).toHaveLength(4);
    expect(stored.every((utterance) => utterance.status === "submitted" && utterance.attemptCount === 2)).toBe(true);
    const media = await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, row.id));
    expect(media).toHaveLength(4);
    expect(media.every((asset) => asset.kind === "source_audio" && /^[0-9a-f]{64}$/.test(asset.sha256))).toBe(true);
    expect(media[0]!.metadataJson).toMatchObject({ browserUserAgent: "RouteTest/1.0" });
    expect(harness.storage.keys().sort()).toEqual(media.map((asset) => asset.storageKey).sort());
    // One automatic ASR job per accepted recording (autoQueueAsr is on).
    const queued = await harness.database.db.select().from(jobs);
    expect(queued.filter((job) => stored.some((utterance) => job.idempotencyKey === `asr:auto:${utterance.id}`))).toHaveLength(4);

    expect(state.step).toBe("background");
    const invalid = await fails(
      await questionnaireRoute(post("/api/study/questionnaires/background", { answers: {} }), { params: Promise.resolve({ key: "background" }) }),
      400,
      "VALIDATION_ERROR",
    );
    expect(invalid.details).toMatchObject({ issues: [{ path: "region" }] });
    await fails(
      await questionnaireRoute(post("/api/study/questionnaires/other", { answers: {} }), { params: Promise.resolve({ key: "other" }) }),
      400,
      "VALIDATION_ERROR",
    );
    state = (
      await ok<sessionSchemas.StateResponse>(
        await questionnaireRoute(post("/api/study/questionnaires/background", { answers: { region: "Kuopio" } }), { params: Promise.resolve({ key: "background" }) }),
      )
    ).state;
    expect(state.step).toBe("post_recording");
    await reload(state);
    state = (
      await ok<sessionSchemas.StateResponse>(
        await questionnaireRoute(post("/api/study/questionnaires/post_recording", { answers: { naturalness: 5 } }), { params: Promise.resolve({ key: "post_recording" }) }),
      )
    ).state;
    expect(state.step).toBe("debrief");
    await reload(state);
    expect(await harness.database.db.select().from(questionnaireResponses).where(eq(questionnaireResponses.sessionId, row.id))).toHaveLength(2);

    const done = await ok<sessionSchemas.StateResponse>(await completeRoute(post("/api/study/session/complete"), noParams));
    expect(done.state.step).toBe("completed");
    const final = await sessionRowOf(token);
    expect(final.status).toBe("completed");
    expect(final.completedAt).not.toBeNull();
    // The cookie is gone: the next person at this browser starts clean.
    expect(fakeCookies.lastWrite(PARTICIPANT_COOKIE_NAME)).toMatchObject({ value: "", options: { maxAge: 0 } });
    expect(cookieToken()).toBeNull();
    expect(await ok(await sessionRoute(get("/api/study/session"), noParams))).toEqual({ state: null });
    const nextParticipant = await startSession();
    expect(nextParticipant.state.step).toBe("consent");
    expect(nextParticipant.state.participantCode).not.toBe(consentState.participantCode);
    expect(JSON.stringify(nextParticipant.state)).not.toContain(consentState.participantCode);
  });

  it("withdrawal removes the pending upload, keeps submitted data, returns the debrief and clears the cookie", async () => {
    const { state, token } = await atTasks();
    const answered = await answerTurn(state);
    const pending = await openTurn(answered.state as TasksState);
    await ok(await audioRoute(audioRequest(pending), withId(pending)));
    const row = await sessionRowOf(token);
    expect(await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, row.id))).toHaveLength(2);

    const { state: ended } = await ok<sessionSchemas.StateResponse>(await withdrawRoute(post("/api/study/session/withdraw"), noParams));
    expect(ended).toMatchObject({ step: "withdrawn", debrief: { content: "Test debrief text." } });
    expect((await sessionRowOf(token)).status).toBe("withdrawn");
    const media = await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, row.id));
    expect(media.map((asset) => asset.id)).toEqual([answered.mediaAssetId]);
    expect(harness.storage.keys()).toEqual([media[0]!.storageKey]);
    expect(cookieToken()).toBeNull();
    // With the old cookie nothing can be written any more.
    useCookie(token);
    await fails(await audioRoute(audioRequest(pending), withId(pending)), 409, "INVALID_STATE");
  });
});

describe("POST /api/study/utterances/:id/audio", () => {
  it("stores the upload with declared metadata kept apart from the measured values", async () => {
    const { state } = await atTasks();
    const utteranceId = await openTurn(state);
    const data = wav(800);
    const upload = await ok<sessionSchemas.UploadAudioResponse>(
      await audioRoute(
        audioRequest(utteranceId, {
          data,
          type: "audio/webm",
          metadata: { captureMethod: "audio_worklet_pcm", declaredDurationMs: 5, requestedConstraints: { echoCancellation: false } },
        }),
        withId(utteranceId),
      ),
    );
    expect(upload).toMatchObject({ durationMs: 800, sizeBytes: data.length, captureQualityClass: "lossless_pcm" });
    expect(upload.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.id, upload.mediaAssetId));
    expect(row).toMatchObject({ kind: "source_audio", mimeType: "audio/wav", durationMs: 800, sampleRateHz: 16000 });
    expect(row!.metadataJson).toMatchObject({
      requestedConstraints: { echoCancellation: false },
      declared: { mimeType: "audio/webm", mimeTypeMatches: false, durationMs: 5 },
    });
  });

  it("returns user-safe errors and stores nothing for an empty, non-audio, too long or too large upload", async () => {
    const { state } = await atTasks();
    const utteranceId = await openTurn(state);
    const id = withId(utteranceId);
    const reasons: Array<[string, Request, number, string]> = [
      ["empty", audioRequest(utteranceId, { data: Buffer.alloc(0) }), 422, "INVALID_AUDIO"],
      ["not audio", audioRequest(utteranceId, { data: Buffer.from("plain text, not audio. ".repeat(40)) }), 422, "INVALID_AUDIO"],
      // The task allows 5 seconds (plus 2 seconds of tolerance).
      ["too long", audioRequest(utteranceId, { data: wav(8000) }), 422, "INVALID_AUDIO"],
      // The study allows 1 MB. 40 seconds of 16 kHz mono are about 1.28 MB.
      ["too large", audioRequest(utteranceId, { data: wav(40_000) }), 413, "PAYLOAD_TOO_LARGE"],
      // Refused from the announced size alone.
      ["announced size", audioRequest(utteranceId, { headers: { "content-length": String(50 * 1024 * 1024) } }), 413, "PAYLOAD_TOO_LARGE"],
      ["missing file part", audioRequest(utteranceId, { partName: "file" }), 400, "VALIDATION_ERROR"],
      ["bad metadata JSON", audioRequest(utteranceId, { metadata: "{not json" }), 400, "VALIDATION_ERROR"],
      ["unknown metadata field", audioRequest(utteranceId, { metadata: { transcript: "x" } }), 400, "VALIDATION_ERROR"],
      ["not multipart", jsonRequest(`${BASE}/api/study/utterances/${utteranceId}/audio`, { body: { audio: "x" } }), 400, "VALIDATION_ERROR"],
    ];
    for (const [name, request, status, code] of reasons) {
      const error = await fails(await audioRoute(request, id), status, code);
      expect(error.message, name).not.toMatch(/ffprobe|\/tmp|\bat \b|Error:/);
    }
    expect(await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.utteranceId, utteranceId))).toHaveLength(0);
    expect(harness.storage.keys()).toHaveLength(0);
    await fails(await audioRoute(audioRequest("not-a-uuid"), withId("not-a-uuid")), 400, "VALIDATION_ERROR");
  });

  it("replaces the earlier upload on a retry or a new recording, and DELETE removes it", async () => {
    const { state } = await atTasks();
    const utteranceId = await openTurn(state);
    const first = await ok<sessionSchemas.UploadAudioResponse>(await audioRoute(audioRequest(utteranceId), withId(utteranceId)));
    const second = await ok<sessionSchemas.UploadAudioResponse>(await audioRoute(audioRequest(utteranceId, { data: wav(500) }), withId(utteranceId)));
    let rows = await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.utteranceId, utteranceId));
    expect(rows.map((row) => row.id)).toEqual([second.mediaAssetId]);
    expect(harness.storage.keys()).toEqual([rows[0]!.storageKey]);
    await fails(
      await submitRoute(post(`/api/study/utterances/${utteranceId}/submit`, { mediaAssetId: first.mediaAssetId }), withId(utteranceId)),
      404,
      "MEDIA_NOT_FOUND",
    );

    const { state: afterDiscard } = await ok<sessionSchemas.StateResponse>(
      await discardRoute(jsonRequest(`${BASE}/api/study/utterances/${utteranceId}/audio`, { method: "DELETE" }), withId(utteranceId)),
    );
    expect((afterDiscard as TasksState).task.turn).toMatchObject({ utteranceId, candidate: null });
    rows = await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.utteranceId, utteranceId));
    expect(rows).toHaveLength(0);
    expect(harness.storage.keys()).toHaveLength(0);

    // Third recording, submitted with the attempt count the browser kept.
    const third = await ok<sessionSchemas.UploadAudioResponse>(await audioRoute(audioRequest(utteranceId), withId(utteranceId)));
    const submit = () =>
      submitRoute(post(`/api/study/utterances/${utteranceId}/submit`, { mediaAssetId: third.mediaAssetId, attemptCount: 3 }), withId(utteranceId));
    const { state: next } = await ok<sessionSchemas.StateResponse>(await submit());
    // A repeated submit gives the same answer.
    expect((await ok<sessionSchemas.StateResponse>(await submit())).state).toEqual(next);
    const [utterance] = await harness.database.db.select().from(utterances).where(eq(utterances.id, utteranceId));
    expect(utterance).toMatchObject({ status: "submitted", attemptCount: 3, acceptedMediaAssetId: third.mediaAssetId });
    // The accepted recording can no longer be replaced or removed.
    await fails(await audioRoute(audioRequest(utteranceId), withId(utteranceId)), 409, "IMMUTABLE_RECORD");
    await fails(
      await discardRoute(jsonRequest(`${BASE}/api/study/utterances/${utteranceId}/audio`, { method: "DELETE" }), withId(utteranceId)),
      409,
      "IMMUTABLE_RECORD",
    );
    expect(harness.storage.keys()).toHaveLength(1);
  });
});

describe("request size and concurrency limits of the participant API", () => {
  function hugeJson(path: string): { request: Request; pulled: () => number } {
    let sent = 0;
    const total = 40 * 1024 * 1024;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) return controller.close();
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
    });
    const request = new Request(`${BASE}${path}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", origin: BASE },
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return { request, pulled: () => sent };
  }

  // A ReadableStream fetches its first chunk when it is created, before anyone
  // reads it. "Not read" therefore means: nothing beyond that first chunk.
  const FIRST_CHUNK = 64 * 1024;

  it("does not read the body of a request without a session", async () => {
    for (const [path, route] of [
      ["/api/study/consent", consentRoute],
      ["/api/study/mic-check", micCheckRoute],
      ["/api/study/utterances", utterancesRoute],
    ] as const) {
      const { request, pulled } = hugeJson(path);
      await fails(await route(request, noParams), 401, "SESSION_EXPIRED");
      expect(pulled(), path).toBeLessThanOrEqual(FIRST_CHUNK);
    }
    const submit = hugeJson(`/api/study/utterances/${UNKNOWN_ID}/submit`);
    await fails(await submitRoute(submit.request, withId(UNKNOWN_ID)), 401, "SESSION_EXPIRED");
    expect(submit.pulled()).toBeLessThanOrEqual(FIRST_CHUNK);
    const questionnaire = hugeJson("/api/study/questionnaires/background");
    await fails(
      await questionnaireRoute(questionnaire.request, { params: Promise.resolve({ key: "background" }) }),
      401,
      "SESSION_EXPIRED",
    );
    expect(questionnaire.pulled()).toBeLessThanOrEqual(FIRST_CHUNK);
  });

  it("refuses a 40 MB JSON body with 413 after reading little more than the limit", async () => {
    // Session creation needs no session, so only the size cap protects it.
    const before = (await harness.database.db.select().from(sessions)).length;
    const create = hugeJson("/api/study/sessions");
    await fails(await sessionsRoute(create.request, noParams), 413, "PAYLOAD_TOO_LARGE");
    expect(create.pulled()).toBeLessThanOrEqual(3 * 64 * 1024);
    expect(await harness.database.db.select().from(sessions)).toHaveLength(before);

    await startSession();
    const consent = hugeJson("/api/study/consent");
    await fails(await consentRoute(consent.request, noParams), 413, "PAYLOAD_TOO_LARGE");
    expect(consent.pulled()).toBeLessThanOrEqual(3 * 64 * 1024);
  });

  it("allows one upload at a time per session: a second concurrent upload gets 409 before its body is read", async () => {
    const { state } = await atTasks();
    const utteranceId = await openTurn(state);

    // The first upload is slow: its body arrives only when the test lets it.
    const form = await new Response(audioRequest(utteranceId).body).arrayBuffer();
    const contentType = audioRequest(utteranceId).headers.get("content-type")!;
    const firstForm = new FormData();
    const data = wav();
    firstForm.set("audio", new Blob([new Uint8Array(data)], { type: "audio/wav" }), "recording.wav");
    const probe = new Request(`${BASE}/x`, { method: "POST", body: firstForm });
    const firstType = probe.headers.get("content-type")!;
    const firstBytes = new Uint8Array(await probe.arrayBuffer());
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const slowBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await gate;
        controller.enqueue(firstBytes);
        controller.close();
      },
    });
    const slow = new Request(`${BASE}/api/study/utterances/${utteranceId}/audio`, {
      method: "POST",
      body: slowBody,
      headers: { origin: BASE, "content-type": firstType },
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const first = audioRoute(slow, withId(utteranceId));
    // Give the first request time to pass the session lookup and take the guard.
    await new Promise((resolve) => setTimeout(resolve, 200));

    let secondPulled = 0;
    const secondBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        secondPulled += 1;
        controller.enqueue(new Uint8Array(form));
        controller.close();
      },
    });
    const second = new Request(`${BASE}/api/study/utterances/${utteranceId}/audio`, {
      method: "POST",
      body: secondBody,
      headers: { origin: BASE, "content-type": contentType },
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const refused = await fails(await audioRoute(second, withId(utteranceId)), 409, "CONFLICT");
    expect(refused.details).toEqual({ reason: "upload_in_progress" });
    expect(secondPulled).toBeLessThanOrEqual(1);

    open();
    const stored = await ok<sessionSchemas.UploadAudioResponse>(await first);
    expect(stored.sizeBytes).toBe(data.length);
    // After the first upload finished, the session can upload again (a re-record).
    await ok(await audioRoute(audioRequest(utteranceId), withId(utteranceId)));
  });

  it("stores exactly the uploaded bytes when they are read as one buffer", async () => {
    const { state } = await atTasks();
    const utteranceId = await openTurn(state);
    const data = wav(700);
    const upload = await ok<sessionSchemas.UploadAudioResponse>(
      await audioRoute(
        audioRequest(utteranceId, { data, metadata: { captureMethod: "audio_worklet_pcm", deviceLabel: "Anna Virtasen AirPods" } }),
        withId(utteranceId),
      ),
    );
    expect(upload.sizeBytes).toBe(data.length);
    const [row] = await harness.database.db.select().from(mediaAssets).where(eq(mediaAssets.id, upload.mediaAssetId));
    const storedBytes = await harness.storage.get(row!.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of storedBytes) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
    // The raw device label never reaches the database.
    expect(JSON.stringify(row)).not.toContain("Virtasen");
    expect(row!.metadataJson).toMatchObject({ declared: { deviceLabel: "bluetooth" } });
  });
});

describe("POST /api/study/session/locale", () => {
  it("stores the language the participant switched to and answers with the state in it", async () => {
    const { token } = await startSession({ locale: "fi" });
    const { state } = await ok<sessionSchemas.StateResponse>(await localeRoute(post("/api/study/session/locale", { locale: "en" }), noParams));
    expect(state.locale).toBe("en");
    expect((await sessionRowOf(token)).locale).toBe("en");
  });

  it("refuses a language the study does not offer", async () => {
    await startSession({ locale: "fi" });
    await fails(await localeRoute(post("/api/study/session/locale", { locale: "sv" }), noParams), 400, "VALIDATION_ERROR");
    await fails(await localeRoute(post("/api/study/session/locale", { locale: "not a tag" }), noParams), 400, "VALIDATION_ERROR");
  });
});
