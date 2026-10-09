// Route tests for the review and transcription API: authentication, validation
// and one pass through the whole flow. The rules themselves are tested with the
// services in packages/research/src/transcripts.
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { adminAuditLog, transcriptRevisions } from "@dialect/db";
import { insertSessionWithUtterance, insertStudy, insertTranscriptWithRevision } from "@dialect/db/testing-builders";
import type { transcriptSchemas } from "@dialect/domain";
import { createAdminSession } from "@/lib/server/admin-auth";
import { jsonRequest, setupServerTestHarness } from "@/lib/server/test/database";
import { POST as resolveFlagRoute } from "./flags/[id]/resolve/route";
import { GET as queueRoute } from "./queue/route";
import { GET as historyRoute } from "../transcripts/[id]/history/route";
import { POST as revisionsRoute } from "../transcripts/[id]/revisions/route";
import { POST as statusRoute } from "../transcripts/[id]/status/route";
import { POST as verifyRoute } from "../transcripts/[id]/verify/route";
import { POST as annotationsRoute } from "../utterances/[id]/annotations/route";
import { POST as flagsRoute } from "../utterances/[id]/flags/route";
import { POST as notesRoute } from "../utterances/[id]/notes/route";
import { GET as utteranceRoute } from "../utterances/[id]/route";
import { POST as utteranceRevisionsRoute } from "../utterances/[id]/transcripts/[type]/revisions/route";

const harness = setupServerTestHarness();
const BASE = "http://localhost:3000/api/admin";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const withParams = <P>(params: P) => ({ params: Promise.resolve(params) });
const get = (url: string) => new Request(url, { method: "GET" });

let utteranceId: string;
let asrRevisionId: string;
let asrTranscriptId: string;
let testModeUtteranceId: string;

beforeAll(async () => {
  const db = harness.database.db;
  const study = await insertStudy(db, {
    settingsJson: { transcriptionConventionVersion: "1.0", annotationSchemeVersion: "1.0", adminTimezone: "Europe/Helsinki" },
  });
  const collected = await insertSessionWithUtterance(db, { studyId: study.id });
  utteranceId = collected.utterance.id;
  const asr = await insertTranscriptWithRevision(db, { utteranceId, type: "asr", text: "Minä en tiedä." });
  asrRevisionId = asr.revision.id;
  asrTranscriptId = asr.transcript.id;
  const testMode = await insertSessionWithUtterance(db, {
    studyId: study.id,
    protocolVersionId: collected.protocol.id,
    session: { mode: "test" },
  });
  testModeUtteranceId = testMode.utterance.id;
});

async function saveRevision(type: string, body: unknown): Promise<Response> {
  return utteranceRevisionsRoute(
    jsonRequest(`${BASE}/utterances/${utteranceId}/transcripts/${type}/revisions`, { body }),
    withParams({ id: utteranceId, type }),
  );
}

describe("authentication", () => {
  const calls: Array<[string, () => Promise<Response>]> = [
    ["GET review/queue", () => queueRoute(get(`${BASE}/review/queue`), withParams({}))],
    ["GET utterances/:id", () => utteranceRoute(get(`${BASE}/utterances/${UNKNOWN_ID}`), withParams({ id: UNKNOWN_ID }))],
    ["GET transcripts/:id/history", () => historyRoute(get(`${BASE}/transcripts/${UNKNOWN_ID}/history`), withParams({ id: UNKNOWN_ID }))],
    ["POST transcripts/:id/revisions", () => revisionsRoute(jsonRequest(`${BASE}/transcripts/${UNKNOWN_ID}/revisions`, { body: { text: "x" } }), withParams({ id: UNKNOWN_ID }))],
    ["POST transcripts/:id/verify", () => verifyRoute(jsonRequest(`${BASE}/transcripts/${UNKNOWN_ID}/verify`, { body: { revisionId: UNKNOWN_ID } }), withParams({ id: UNKNOWN_ID }))],
    ["POST transcripts/:id/status", () => statusRoute(jsonRequest(`${BASE}/transcripts/${UNKNOWN_ID}/status`, { body: { status: "needs_review" } }), withParams({ id: UNKNOWN_ID }))],
    ["POST utterances/:id/transcripts/:type/revisions", () => saveRevision("human_dialect", { text: "x" })],
    ["POST utterances/:id/annotations", () => annotationsRoute(jsonRequest(`${BASE}/utterances/${UNKNOWN_ID}/annotations`, { body: {} }), withParams({ id: UNKNOWN_ID }))],
    ["POST utterances/:id/flags", () => flagsRoute(jsonRequest(`${BASE}/utterances/${UNKNOWN_ID}/flags`, { body: { reasonCode: "other" } }), withParams({ id: UNKNOWN_ID }))],
    ["POST utterances/:id/notes", () => notesRoute(jsonRequest(`${BASE}/utterances/${UNKNOWN_ID}/notes`, { body: { body: "x" } }), withParams({ id: UNKNOWN_ID }))],
    ["POST review/flags/:id/resolve", () => resolveFlagRoute(jsonRequest(`${BASE}/review/flags/${UNKNOWN_ID}/resolve`, { body: {} }), withParams({ id: UNKNOWN_ID }))],
  ];

  it.each(calls)("%s answers 401 without an admin session", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("rejects a cross-origin save even with a valid session, and stores nothing", async () => {
    await createAdminSession();
    const response = await utteranceRevisionsRoute(
      jsonRequest(`${BASE}/utterances/${utteranceId}/transcripts/human_dialect/revisions`, {
        body: { text: "Mie en tiiä." },
        headers: { origin: "https://evil.example" },
      }),
      withParams({ id: utteranceId, type: "human_dialect" }),
    );
    expect(response.status).toBe(403);
    const review = await utteranceRoute(get(`${BASE}/utterances/${utteranceId}`), withParams({ id: utteranceId }));
    expect(((await review.json()) as transcriptSchemas.UtteranceForReview).transcripts.human_dialect).toBeNull();
  });
});

describe("validation", () => {
  it("rejects the ASR type, an unknown type, an empty text and a malformed id", async () => {
    await createAdminSession();
    for (const type of ["asr", "translation"]) {
      const response = await saveRevision(type, { text: "Minä en tiedä." });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    }
    const empty = await saveRevision("human_dialect", { text: "   " });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.details.issues[0].path).toBe("text");

    const malformed = await utteranceRoute(get(`${BASE}/utterances/abc`), withParams({ id: "abc" }));
    expect(malformed.status).toBe(400);
    const missing = await utteranceRoute(get(`${BASE}/utterances/${UNKNOWN_ID}`), withParams({ id: UNKNOWN_ID }));
    expect(missing.status).toBe(404);

    // The ASR revision in the database is untouched.
    const rows = await harness.database.db
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.transcriptId, asrTranscriptId));
    expect(rows.map((row) => row.text)).toEqual(["Minä en tiedä."]);
  });

  it("does not add a revision to the ASR transcript through the transcript path", async () => {
    await createAdminSession();
    const response = await revisionsRoute(
      jsonRequest(`${BASE}/transcripts/${asrTranscriptId}/revisions`, { body: { text: "Muutettu." } }),
      withParams({ id: asrTranscriptId }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("IMMUTABLE_RECORD");
  });

  it("rejects wrong queue parameters, flag reasons, statuses and annotation categories", async () => {
    await createAdminSession();
    const queue = await queueRoute(get(`${BASE}/review/queue?condition=everything`), withParams({}));
    expect(queue.status).toBe(400);
    const pageSize = await queueRoute(get(`${BASE}/review/queue?pageSize=100000`), withParams({}));
    expect(pageSize.status).toBe(400);

    const flag = await flagsRoute(
      jsonRequest(`${BASE}/utterances/${utteranceId}/flags`, { body: { reasonCode: "boring" } }),
      withParams({ id: utteranceId }),
    );
    expect(flag.status).toBe(400);

    const status = await statusRoute(
      jsonRequest(`${BASE}/transcripts/${asrTranscriptId}/status`, { body: { status: "verified" } }),
      withParams({ id: asrTranscriptId }),
    );
    expect(status.status).toBe(400);

    const annotation = await annotationsRoute(
      jsonRequest(`${BASE}/utterances/${utteranceId}/annotations`, {
        body: { sourceTranscriptRevisionId: asrRevisionId, targetTranscriptRevisionId: asrRevisionId, categories: ["dialect_loss"] },
      }),
      withParams({ id: utteranceId }),
    );
    expect(annotation.status).toBe(400);

    const note = await notesRoute(
      jsonRequest(`${BASE}/utterances/${utteranceId}/notes`, { body: { body: "" } }),
      withParams({ id: utteranceId }),
    );
    expect(note.status).toBe(400);

    const notJson = await saveRevision("human_dialect", undefined);
    expect(notJson.status).toBe(400);
  });
});

describe("review flow", () => {
  it("saves, verifies, revises with a reason, codes differences, flags and lists", async () => {
    await createAdminSession();

    const saved = await saveRevision("human_dialect", { text: "Mie en tiiä.", annotatorLabel: "annotator-1", expectedCurrentRevisionId: null });
    expect(saved.status).toBe(200);
    const first = (await saved.json()) as transcriptSchemas.SaveRevisionResponse;
    expect(first).toMatchObject({ created: true, transcript: { status: "draft", type: "human_dialect" }, revision: { revisionNumber: 1 } });
    expect(first.revision.createdByLabel).toBe("annotator-1");

    // A save that says it was based on "no revision yet" is now stale.
    const stale = await saveRevision("human_dialect", { text: "Toinen teksti.", expectedCurrentRevisionId: null });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("CONFLICT");

    const transcriptId = first.transcript.id;
    const verified = await verifyRoute(
      jsonRequest(`${BASE}/transcripts/${transcriptId}/verify`, { body: { revisionId: first.revision.id, verificationNotes: "ok" } }),
      withParams({ id: transcriptId }),
    );
    expect(verified.status).toBe(200);
    expect(((await verified.json()) as transcriptSchemas.VerifyTranscriptResponse).transcript.status).toBe("verified");

    const noReason = await revisionsRoute(
      jsonRequest(`${BASE}/transcripts/${transcriptId}/revisions`, { body: { text: "Mie en oikeestaan tiiä." } }),
      withParams({ id: transcriptId }),
    );
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).error.details.issues[0].path).toBe("changeReason");

    const revised = await revisionsRoute(
      jsonRequest(`${BASE}/transcripts/${transcriptId}/revisions`, {
        body: { text: "Mie en oikeestaan tiiä.", changeReason: "Missed a word." },
      }),
      withParams({ id: transcriptId }),
    );
    expect(revised.status).toBe(200);
    const second = (await revised.json()) as transcriptSchemas.SaveRevisionResponse;
    expect(second).toMatchObject({ transcript: { status: "draft", revisionCount: 2 }, revision: { revisionNumber: 2 } });

    const staleVerify = await verifyRoute(
      jsonRequest(`${BASE}/transcripts/${transcriptId}/verify`, { body: { revisionId: first.revision.id } }),
      withParams({ id: transcriptId }),
    );
    expect(staleVerify.status).toBe(409);

    const needsReview = await statusRoute(
      jsonRequest(`${BASE}/transcripts/${transcriptId}/status`, { body: { status: "needs_review" } }),
      withParams({ id: transcriptId }),
    );
    expect(needsReview.status).toBe(200);

    const history = await historyRoute(get(`${BASE}/transcripts/${transcriptId}/history`), withParams({ id: transcriptId }));
    const historyBody = (await history.json()) as transcriptSchemas.TranscriptHistoryResponse;
    expect(historyBody.revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
    expect(historyBody.revisions[1]?.verifiedAt).not.toBeNull();

    const annotation = await annotationsRoute(
      jsonRequest(`${BASE}/utterances/${utteranceId}/annotations`, {
        body: {
          sourceTranscriptRevisionId: asrRevisionId,
          targetTranscriptRevisionId: second.revision.id,
          categories: ["normalization", "omission"],
          annotatorLabel: "annotator-1",
        },
      }),
      withParams({ id: utteranceId }),
    );
    expect(annotation.status).toBe(200);
    expect(((await annotation.json()) as transcriptSchemas.SaveDifferenceAnnotationResponse).annotation.categories).toEqual([
      "normalization",
      "omission",
    ]);

    const flag = await flagsRoute(
      jsonRequest(`${BASE}/utterances/${utteranceId}/flags`, {
        body: { reasonCode: "contains_third_party_identifier", notes: "A full name at the end." },
      }),
      withParams({ id: utteranceId }),
    );
    expect(flag.status).toBe(200);
    const flagId = ((await flag.json()) as transcriptSchemas.AddFlagResponse).flag.id;

    const note = await notesRoute(
      jsonRequest(`${BASE}/utterances/${utteranceId}/notes`, { body: { body: "Check the last word.", transcriptId } }),
      withParams({ id: utteranceId }),
    );
    expect(note.status).toBe(200);
    expect(((await note.json()) as transcriptSchemas.AddNoteResponse).note.transcriptType).toBe("human_dialect");

    const review = await utteranceRoute(get(`${BASE}/utterances/${utteranceId}`), withParams({ id: utteranceId }));
    expect(review.status).toBe(200);
    const reviewBody = (await review.json()) as transcriptSchemas.UtteranceForReview;
    expect(reviewBody.transcripts.human_dialect).toMatchObject({ status: "needs_review", revisionCount: 2 });
    expect(reviewBody.transcripts.asr?.currentRevision?.text).toBe("Minä en tiedä.");
    expect(reviewBody.flags).toHaveLength(1);
    expect(reviewBody.notes).toHaveLength(1);
    expect(reviewBody.differenceAnnotations.latest).toHaveLength(1);

    // The queue shows research rows by default; the TEST utterance appears only when asked.
    const queue = await queueRoute(get(`${BASE}/review/queue?condition=flagged&condition=needs_review`), withParams({}));
    const queueBody = (await queue.json()) as transcriptSchemas.ReviewQueueResponse;
    expect(queueBody.rows.map((row) => row.utteranceId)).toEqual([utteranceId]);
    expect(queueBody.pageSize).toBe(50);
    const everything = await queueRoute(get(`${BASE}/review/queue`), withParams({}));
    expect(((await everything.json()) as transcriptSchemas.ReviewQueueResponse).rows.map((row) => row.utteranceId)).toEqual([utteranceId]);
    const testRows = await queueRoute(get(`${BASE}/review/queue?mode=test`), withParams({}));
    expect(((await testRows.json()) as transcriptSchemas.ReviewQueueResponse).rows.map((row) => row.utteranceId)).toEqual([
      testModeUtteranceId,
    ]);
    const search = await queueRoute(get(`${BASE}/review/queue?search=oikeestaan`), withParams({}));
    expect(((await search.json()) as transcriptSchemas.ReviewQueueResponse).total).toBe(1);

    const resolved = await resolveFlagRoute(
      new Request(`${BASE}/review/flags/${flagId}/resolve`, { method: "POST", headers: { origin: "http://localhost:3000" } }),
      withParams({ id: flagId }),
    );
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as transcriptSchemas.ResolveFlagResponse).flag.resolvedAt).not.toBeNull();

    const actions = (
      await harness.database.db.select({ action: adminAuditLog.action }).from(adminAuditLog).where(eq(adminAuditLog.entityId, transcriptId))
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(["transcript.save_revision", "transcript.verify", "transcript.revise_verified", "note.create"]),
    );
    // Transcript text never reaches the request log.
    expect(harness.logLines.join("")).not.toContain("oikeestaan");
  });
});
