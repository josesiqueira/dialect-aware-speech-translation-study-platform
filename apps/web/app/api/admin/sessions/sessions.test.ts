import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminAuditLog, sessions, translations, utterances } from "@dialect/db";
import {
  insertProcessingBatch,
  insertSessionWithUtterance,
  insertTranscriptWithRevision,
  insertTranslation,
  type CollectedSession,
} from "@dialect/db/testing-builders";
import { createAdminSession } from "@/lib/server/admin-auth";
import { jsonRequest, noParams, setupServerTestHarness } from "@/lib/server/test/database";
import { GET as auditLog } from "../audit/route";
import { GET as dashboard } from "../dashboard/route";
import { GET as sessionAudit } from "./[id]/audit/route";
import { POST as excludeSession } from "./[id]/exclude/route";
import { PATCH as flagSession } from "./[id]/flag/route";
import { POST as includeSession } from "./[id]/include/route";
import { POST as sessionNote } from "./[id]/notes/route";
import { GET as detail } from "./[id]/route";
import { POST as excludeUtterance } from "./[id]/utterances/[utteranceId]/exclude/route";
import { PATCH as flagUtterance } from "./[id]/utterances/[utteranceId]/flag/route";
import { POST as includeUtterance } from "./[id]/utterances/[utteranceId]/include/route";
import { POST as utteranceNote } from "./[id]/utterances/[utteranceId]/notes/route";
import { POST as outputNote } from "./outputs/[kind]/[outputId]/notes/route";
import { PATCH as outputStatus } from "./outputs/[kind]/[outputId]/status/route";
import { GET as list } from "./route";

const harness = setupServerTestHarness();
const API = "http://localhost:3000/api/admin";
const MISSING = "00000000-0000-4000-8000-000000000000";

let research: CollectedSession;
let test: CollectedSession;
let translationId: string;

const p = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

beforeAll(async () => {
  const db = harness.database.db;
  research = await insertSessionWithUtterance(db, {
    session: { status: "completed", participantCode: "P-ROUTE001", startedAt: new Date("2026-10-01T08:00:00.000Z") },
  });
  test = await insertSessionWithUtterance(db, {
    studyId: research.study.id,
    protocolVersionId: research.protocol.id,
    session: { mode: "test", participantCode: "P-ROUTE002", startedAt: new Date("2026-10-02T08:00:00.000Z") },
  });
  const { revision } = await insertTranscriptWithRevision(db, { utteranceId: research.utterance.id, status: "verified" });
  const batch = await insertProcessingBatch(db, { studyId: research.study.id, name: "route-batch", status: "completed" });
  const { translation } = await insertTranslation(db, {
    sourceTranscriptRevisionId: revision.id,
    processingBatchId: batch.id,
    conditionKey: "default",
  });
  translationId = translation.id;
});

describe("corpus routes without an admin session", () => {
  it("reject every request with 401 and change nothing", async () => {
    const s = research.session.id;
    const u = research.utterance.id;
    const body = { flagged: true, reason: "x", body: "x", status: "excluded" };
    const responses = await Promise.all([
      dashboard(new Request(`${API}/dashboard`), noParams),
      list(new Request(`${API}/sessions`), noParams),
      detail(new Request(`${API}/sessions/${s}`), p({ id: s })),
      flagSession(jsonRequest(`${API}/sessions/${s}/flag`, { method: "PATCH", body }), p({ id: s })),
      excludeSession(jsonRequest(`${API}/sessions/${s}/exclude`, { body }), p({ id: s })),
      includeSession(jsonRequest(`${API}/sessions/${s}/include`, {}), p({ id: s })),
      sessionNote(jsonRequest(`${API}/sessions/${s}/notes`, { body }), p({ id: s })),
      sessionAudit(new Request(`${API}/sessions/${s}/audit`), p({ id: s })),
      flagUtterance(jsonRequest(`${API}/sessions/${s}/utterances/${u}/flag`, { method: "PATCH", body }), p({ id: s, utteranceId: u })),
      excludeUtterance(jsonRequest(`${API}/sessions/${s}/utterances/${u}/exclude`, { body }), p({ id: s, utteranceId: u })),
      includeUtterance(jsonRequest(`${API}/sessions/${s}/utterances/${u}/include`, {}), p({ id: s, utteranceId: u })),
      utteranceNote(jsonRequest(`${API}/sessions/${s}/utterances/${u}/notes`, { body }), p({ id: s, utteranceId: u })),
      outputStatus(
        jsonRequest(`${API}/sessions/outputs/translations/${translationId}/status`, { method: "PATCH", body }),
        p({ kind: "translations", outputId: translationId }),
      ),
      outputNote(
        jsonRequest(`${API}/sessions/outputs/translations/${translationId}/notes`, { body }),
        p({ kind: "translations", outputId: translationId }),
      ),
      auditLog(new Request(`${API}/audit`), noParams),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHORIZED");
      expect(response.headers.get("cache-control")).toBe("no-store, private");
    }
    const db = harness.database.db;
    const [session] = await db.select().from(sessions).where(eq(sessions.id, s));
    const [utterance] = await db.select().from(utterances).where(eq(utterances.id, u));
    const [translation] = await db.select().from(translations).where(eq(translations.id, translationId));
    expect(session).toMatchObject({ flagged: false, excluded: false });
    expect(utterance).toMatchObject({ flagged: false, status: "submitted" });
    expect(translation?.status).toBe("generated");
    expect(await db.select().from(adminAuditLog)).toEqual([]);
  });
});

describe("corpus routes with an admin session", () => {
  beforeEach(async () => {
    await createAdminSession();
  });

  it("GET /dashboard returns research counts with demo and test apart", async () => {
    const response = await dashboard(new Request(`${API}/dashboard?days=3`), noParams);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const body = await response.json();
    expect(body.participants).toMatchObject({ started: 1, completed: 1 });
    expect(body.otherModes.test.sessions).toBe(1);
    expect(body.sessionsPerDay).toHaveLength(3);
    expect((await dashboard(new Request(`${API}/dashboard?days=0`), noParams)).status).toBe(400);
  });

  it("GET /sessions paginates, filters and validates the query", async () => {
    const all = await (await list(new Request(`${API}/sessions`), noParams)).json();
    expect(all).toMatchObject({ total: 2, page: 1, pageSize: 50, sort: "started_at", direction: "desc" });
    expect(all.items.map((item: { participantCode: string }) => item.participantCode)).toEqual(["P-ROUTE002", "P-ROUTE001"]);

    const filtered = await (await list(new Request(`${API}/sessions?mode=research&flagged=false&pageSize=1`), noParams)).json();
    expect(filtered.items.map((item: { participantCode: string }) => item.participantCode)).toEqual(["P-ROUTE001"]);
    const searched = await (await list(new Request(`${API}/sessions?search=route002`), noParams)).json();
    expect(searched.items).toHaveLength(1);

    expect((await list(new Request(`${API}/sessions?mode=production`), noParams)).status).toBe(400);
    expect((await list(new Request(`${API}/sessions?pageSize=100000`), noParams)).status).toBe(400);
  });

  it("GET /sessions/:id returns the detail, 404 for an unknown id and 400 for a malformed one", async () => {
    const response = await detail(new Request(`${API}/sessions/${research.session.id}`), p({ id: research.session.id }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.session.participantCode).toBe("P-ROUTE001");
    expect(body.utterances[0].promptSnapshot).toBe(research.presentation.promptSnapshot);
    expect(body.utterances[0].translationBatches[0].batch.name).toBe("route-batch");
    // The storage key of a recording is never sent to the browser.
    expect(JSON.stringify(body)).not.toContain(research.media.storageKey);

    expect((await detail(new Request(`${API}/sessions/${MISSING}`), p({ id: MISSING }))).status).toBe(404);
    expect((await detail(new Request(`${API}/sessions/outputs`), p({ id: "outputs" }))).status).toBe(400);
  });

  it("flags, excludes, includes and annotates a session and its utterance", async () => {
    const s = test.session.id;
    const u = test.utterance.id;
    const flagged = await flagSession(
      jsonRequest(`${API}/sessions/${s}/flag`, { method: "PATCH", body: { flagged: true, notes: "check audio" } }),
      p({ id: s }),
    );
    expect(await flagged.json()).toEqual({ id: s, flagged: true, flagNotes: "check audio" });

    const excluded = await excludeSession(jsonRequest(`${API}/sessions/${s}/exclude`, { body: { reason: "pilot run" } }), p({ id: s }));
    expect(await excluded.json()).toEqual({ id: s, excluded: true, exclusionReason: "pilot run" });
    expect((await excludeSession(jsonRequest(`${API}/sessions/${s}/exclude`, { body: {} }), p({ id: s }))).status).toBe(400);
    const included = await includeSession(jsonRequest(`${API}/sessions/${s}/include`, {}), p({ id: s }));
    expect(await included.json()).toMatchObject({ excluded: false });

    const note = await sessionNote(jsonRequest(`${API}/sessions/${s}/notes`, { body: { body: "A session note" } }), p({ id: s }));
    expect((await note.json()).note).toMatchObject({ entityType: "session", entityId: s, body: "A session note" });

    const utteranceFlag = await flagUtterance(
      jsonRequest(`${API}/sessions/${s}/utterances/${u}/flag`, { method: "PATCH", body: { flagged: true, reasonCode: "poor_audio" } }),
      p({ id: s, utteranceId: u }),
    );
    expect(await utteranceFlag.json()).toMatchObject({ id: u, flagged: true });
    const utteranceExcluded = await excludeUtterance(
      jsonRequest(`${API}/sessions/${s}/utterances/${u}/exclude`, { body: { reason: "silence" } }),
      p({ id: s, utteranceId: u }),
    );
    expect(await utteranceExcluded.json()).toEqual({ id: u, status: "excluded", exclusionReason: "silence" });
    const utteranceIncluded = await includeUtterance(
      jsonRequest(`${API}/sessions/${s}/utterances/${u}/include`, {}),
      p({ id: s, utteranceId: u }),
    );
    expect(await utteranceIncluded.json()).toEqual({ id: u, status: "submitted", exclusionReason: null });
    const utteranceNoteResponse = await utteranceNote(
      jsonRequest(`${API}/sessions/${s}/utterances/${u}/notes`, { body: { body: "An utterance note" } }),
      p({ id: s, utteranceId: u }),
    );
    expect(utteranceNoteResponse.status).toBe(200);

    // The utterance of another session is not reachable through this session.
    const wrong = await flagUtterance(
      jsonRequest(`${API}/sessions/${research.session.id}/utterances/${u}/flag`, { method: "PATCH", body: { flagged: false } }),
      p({ id: research.session.id, utteranceId: u }),
    );
    expect(wrong.status).toBe(404);

    const audit = await (await sessionAudit(new Request(`${API}/sessions/${s}/audit`), p({ id: s }))).json();
    expect(audit.items.map((item: { action: string }) => item.action).sort()).toEqual(
      [
        "note.create",
        "note.create",
        "session.exclude",
        "session.flag",
        "session.include",
        "utterance.exclude",
        "utterance.flag",
        "utterance.include",
      ].sort(),
    );
    expect(audit.items.every((item: { actorLabel: string }) => item.actorLabel === "admin")).toBe(true);
  });

  it("rejects a state-changing request from another origin", async () => {
    const s = test.session.id;
    const response = await excludeSession(
      jsonRequest(`${API}/sessions/${s}/exclude`, { body: { reason: "x" }, sameOrigin: false }),
      p({ id: s }),
    );
    expect(response.status).toBe(403);
  });

  it("changes the status of an output and nothing else", async () => {
    const before = (await harness.database.db.select().from(translations).where(eq(translations.id, translationId)))[0];
    const response = await outputStatus(
      jsonRequest(`${API}/sessions/outputs/translations/${translationId}/status`, {
        method: "PATCH",
        body: { status: "excluded", reasonCode: "translation_problem", translatedText: "changed" },
      }),
      p({ kind: "translations", outputId: translationId }),
    );
    expect(await response.json()).toEqual({ entityType: "translation", id: translationId, status: "excluded" });
    const after = (await harness.database.db.select().from(translations).where(eq(translations.id, translationId)))[0];
    expect(after).toEqual({ ...before, status: "excluded" });

    const badKind = await outputStatus(
      jsonRequest(`${API}/sessions/outputs/transcripts/${translationId}/status`, { method: "PATCH", body: { status: "excluded" } }),
      p({ kind: "transcripts", outputId: translationId }),
    );
    expect(badKind.status).toBe(400);
    const badStatus = await outputStatus(
      jsonRequest(`${API}/sessions/outputs/translations/${translationId}/status`, { method: "PATCH", body: { status: "deleted" } }),
      p({ kind: "translations", outputId: translationId }),
    );
    expect(badStatus.status).toBe(400);
    const note = await outputNote(
      jsonRequest(`${API}/sessions/outputs/translations/${translationId}/notes`, { body: { body: "Odd wording" } }),
      p({ kind: "translations", outputId: translationId }),
    );
    expect((await note.json()).note).toMatchObject({ entityType: "translation", entityId: translationId });
  });

  it("GET /audit filters the audit log", async () => {
    const body = await (await auditLog(new Request(`${API}/audit?action=session.exclude`), noParams)).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ action: "session.exclude", entityId: test.session.id });
    expect((await auditLog(new Request(`${API}/audit?entityId=nope`), noParams)).status).toBe(400);
  });
});
