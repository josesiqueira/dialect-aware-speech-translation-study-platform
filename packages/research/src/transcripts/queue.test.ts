import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questionnaireAnswers, questionnaireResponses, utterances } from "@dialect/db";
import {
  insertPublishedProtocol,
  insertQuestionnaire,
  insertSession,
  insertStudy,
  insertTaskPresentation,
  insertTranscriptWithRevision,
  insertUtteranceWithMedia,
  type ProtocolTaskRow,
} from "@dialect/db/testing-builders";
import type { StudyMode } from "@dialect/domain";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { addFlag, listReviewQueue, resolveFlag, saveTranscriptRevision, setTranscriptStatus, verifyTranscript } from "./index";

let t: TestServiceContext;
let studyId: string;
let protocolVersionId: string;
let otherProtocolVersionId: string;
let tasks: ProtocolTaskRow[];
let otherTasks: ProtocolTaskRow[];
let regionItemId: string;
let regionQuestionnaireVersionId: string;

// Sessions start one minute apart so the queue order is known.
let sessionCounter = 0;

async function addUtterance(
  options: { mode?: StudyMode; taskIndex?: number; protocol?: string; region?: string; status?: "submitted" | "excluded" } = {},
): Promise<{ utteranceId: string; sessionId: string; participantCode: string }> {
  const db = t.testDb.db;
  sessionCounter += 1;
  const protocolId = options.protocol ?? protocolVersionId;
  const session = await insertSession(db, {
    studyId,
    protocolVersionId: protocolId,
    mode: options.mode ?? "research",
    status: "completed",
    startedAt: new Date(Date.UTC(2026, 8, 1, 10, sessionCounter)),
  });
  const task = options.protocol ? otherTasks[0] : tasks[options.taskIndex ?? 0];
  if (!task) throw new Error("No task for the protocol");
  const taskId = task.id;
  const presentation = await insertTaskPresentation(db, { sessionId: session.id, protocolTaskId: taskId });
  const { utterance } = await insertUtteranceWithMedia(db, { sessionId: session.id, taskPresentationId: presentation.id });
  if (options.status === "excluded") {
    await db.update(utterances).set({ status: "excluded", exclusionReason: "test" }).where(eq(utterances.id, utterance.id));
  }
  if (options.region) {
    const [response] = await db
      .insert(questionnaireResponses)
      .values({ sessionId: session.id, questionnaireVersionId: regionQuestionnaireVersionId })
      .returning();
    await db
      .insert(questionnaireAnswers)
      .values({ responseId: response!.id, questionnaireItemId: regionItemId, valueJson: options.region });
  }
  return { utteranceId: utterance.id, sessionId: session.id, participantCode: session.participantCode };
}

const save = (utteranceId: string, type: "asr_corrected" | "human_dialect" | "normalized", text: string) =>
  saveTranscriptRevision(t.adminCtx, { utteranceId, type, text });

async function queueIds(filters: Parameters<typeof listReviewQueue>[1] = {}): Promise<string[]> {
  const result = await listReviewQueue(t.adminCtx, filters, { pageSize: 200 });
  return result.rows.map((row) => row.utteranceId);
}

// The mock data of this file:
//   u1 research, controlled       A only
//   u2 research, controlled       A, B draft ("mie oon")
//   u3 research, semi-structured  B verified, C needs_review, region Kainuu
//   u4 research, controlled       A* draft, open flag on the utterance
//   u5 research, controlled       B and C, open flag on the B transcript, protocol 2
//   u6 test,     controlled       B draft ("mie oon testi")
//   u7 demo,     controlled       nothing
//   u8 research, controlled       excluded utterance
let u1: string, u2: string, u3: string, u4: string, u5: string, u6: string, u7: string, u8: string;
let u2Code: string;
let u4FlagId: string;

beforeAll(async () => {
  t = await createTestServiceContext();
  const db = t.testDb.db;
  const study = await insertStudy(db, { settingsJson: { adminTimezone: "Europe/Helsinki", annotationSchemeVersion: "1.0" } });
  studyId = study.id;
  const first = await insertPublishedProtocol(db, { studyId });
  protocolVersionId = first.protocol.id;
  tasks = first.tasks;
  const second = await insertPublishedProtocol(db, { studyId, consentVersionId: first.consent.id });
  otherProtocolVersionId = second.protocol.id;
  otherTasks = second.tasks;
  const questionnaire = await insertQuestionnaire(db, {
    studyId,
    key: "background",
    items: [{ itemKey: "region_grew_up", type: "short_text", prompt: "Where did you grow up?" }],
  });
  regionQuestionnaireVersionId = questionnaire.version.id;
  regionItemId = questionnaire.items[0]!.id;

  const semiIndex = tasks.findIndex((task) => task.taskType === "semi_structured");

  const first1 = await addUtterance();
  u1 = first1.utteranceId;
  await insertTranscriptWithRevision(db, { utteranceId: u1, type: "asr", text: "Minä olen täällä." });

  const second2 = await addUtterance();
  u2 = second2.utteranceId;
  u2Code = second2.participantCode;
  await insertTranscriptWithRevision(db, { utteranceId: u2, type: "asr", text: "Minä olen." });
  await save(u2, "human_dialect", "No mie oon 100% varma_siitä.");

  u3 = (await addUtterance({ taskIndex: semiIndex, region: "Kainuu, Kajaani" })).utteranceId;
  const b3 = await save(u3, "human_dialect", "Myö lähetään.");
  await verifyTranscript(t.adminCtx, { transcriptId: b3.transcript.id, revisionId: b3.revision.id });
  const c3 = await save(u3, "normalized", "Me lähdemme.");
  await setTranscriptStatus(t.adminCtx, { transcriptId: c3.transcript.id, status: "needs_review" });

  u4 = (await addUtterance({ region: "Helsinki" })).utteranceId;
  await save(u4, "asr_corrected", "Minä olen täällä.");
  u4FlagId = (await addFlag(t.adminCtx, { entityType: "utterance", entityId: u4, reasonCode: "poor_audio" })).flag.id;

  u5 = (await addUtterance({ protocol: otherProtocolVersionId })).utteranceId;
  const b5 = await save(u5, "human_dialect", "Sie oot.");
  await save(u5, "normalized", "Sinä olet.");
  await addFlag(t.adminCtx, { entityType: "transcript", entityId: b5.transcript.id, reasonCode: "needs_expert_review" });

  u6 = (await addUtterance({ mode: "test" })).utteranceId;
  await save(u6, "human_dialect", "Mie oon testi.");

  u7 = (await addUtterance({ mode: "demo" })).utteranceId;
  u8 = (await addUtterance({ status: "excluded" })).utteranceId;
});

afterAll(async () => {
  await t.cleanup();
});

describe("listReviewQueue", () => {
  it("lists research utterances only by default, in session order, with transcript states", async () => {
    const result = await listReviewQueue(t.adminCtx);
    expect(result.rows.map((row) => row.utteranceId)).toEqual([u1, u2, u3, u4, u5]);
    expect(result).toMatchObject({ page: 1, pageSize: 50, total: 5, adminTimezone: "Europe/Helsinki" });
    expect(result.rows.every((row) => row.mode === "research")).toBe(true);
    expect(result.protocolVersions.map((version) => version.id).sort()).toEqual(
      [protocolVersionId, otherProtocolVersionId].sort(),
    );

    const row2 = result.rows[1]!;
    expect(row2.transcripts.asr).toMatchObject({ status: "draft", hasRevision: true });
    expect(row2.transcripts.human_dialect).toMatchObject({ status: "draft", hasRevision: true });
    expect(row2.transcripts.asr_corrected).toBeNull();
    expect(row2.transcripts.normalized).toBeNull();
    expect(row2).toMatchObject({ taskType: "controlled", participantCode: u2Code, flagged: false, openFlagCount: 0 });

    const row3 = result.rows[2]!;
    expect(row3.taskType).toBe("semi_structured");
    expect(row3.transcripts.human_dialect?.status).toBe("verified");
    expect(row3.transcripts.normalized?.status).toBe("needs_review");
  });

  it("shows test and demo rows only when asked", async () => {
    expect(await queueIds({ modes: ["test"] })).toEqual([u6]);
    expect(await queueIds({ modes: ["demo"] })).toEqual([u7]);
    expect(await queueIds({ modes: ["research", "test", "demo"] })).toEqual([u1, u2, u3, u4, u5, u6, u7]);
    // A text search does not widen the mode either.
    expect(await queueIds({ search: "mie oon" })).toEqual([u2]);
  });

  it("hides excluded utterances unless asked", async () => {
    expect(await queueIds()).not.toContain(u8);
    expect(await queueIds({ includeExcluded: true })).toContain(u8);
  });

  it("filters B missing, C missing, A* missing and unreviewed", async () => {
    expect(await queueIds({ conditions: ["b_missing"] })).toEqual([u1, u4]);
    expect(await queueIds({ conditions: ["c_missing"] })).toEqual([u1, u2, u4]);
    expect(await queueIds({ conditions: ["a_star_missing"] })).toEqual([u1, u2, u3, u5]);
    expect(await queueIds({ conditions: ["unreviewed"] })).toEqual([u1]);
    // Conditions are combined with AND.
    expect(await queueIds({ conditions: ["c_missing", "a_star_missing"] })).toEqual([u1, u2]);
  });

  it("filters needs second review", async () => {
    expect(await queueIds({ conditions: ["needs_review"] })).toEqual([u3]);
  });

  it("filters flagged: open flags on the utterance or one of its transcripts, and the utterance flag column", async () => {
    expect(await queueIds({ conditions: ["flagged"] })).toEqual([u4, u5]);
    const result = await listReviewQueue(t.adminCtx, { conditions: ["flagged"] });
    expect(result.rows.map((row) => [row.flagged, row.openFlagCount])).toEqual([
      [true, 1],
      [true, 1],
    ]);

    await t.testDb.db.update(utterances).set({ flagged: true }).where(eq(utterances.id, u1));
    expect(await queueIds({ conditions: ["flagged"] })).toEqual([u1, u4, u5]);
    await t.testDb.db.update(utterances).set({ flagged: false }).where(eq(utterances.id, u1));

    // A resolved flag no longer counts.
    await resolveFlag(t.adminCtx, { flagId: u4FlagId });
    expect(await queueIds({ conditions: ["flagged"] })).toEqual([u5]);
  });

  it("filters by task type and protocol version", async () => {
    expect(await queueIds({ taskType: "semi_structured" })).toEqual([u3]);
    expect(await queueIds({ taskType: "free_speech" })).toEqual([]);
    expect(await queueIds({ protocolVersionId: otherProtocolVersionId })).toEqual([u5]);
  });

  it("searches the current transcript revisions, the participant code and the utterance id", async () => {
    expect(await queueIds({ search: "MIE OON" })).toEqual([u2]);
    expect(await queueIds({ search: "olen täällä" })).toEqual([u1, u4]);
    expect(await queueIds({ search: u2Code.toLowerCase() })).toEqual([u2]);
    expect(await queueIds({ search: u5.slice(0, 13) })).toEqual([u5]);
    expect(await queueIds({ search: "ei löydy mistään" })).toEqual([]);
    // LIKE wildcards in the search text are matched literally.
    expect(await queueIds({ search: "100%" })).toEqual([u2]);
    expect(await queueIds({ search: "varma_siitä" })).toEqual([u2]);
    expect(await queueIds({ search: "100_" })).toEqual([]);
    expect(await queueIds({ search: "%" })).toEqual([u2]);

    // Only the current revision is searched.
    await save(u2, "human_dialect", "No mie olen 100% varma_siitä.");
    expect(await queueIds({ search: "mie oon" })).toEqual([]);
  });

  it("filters by region as a text match on a questionnaire answer", async () => {
    expect(await queueIds({ region: "kainuu" })).toEqual([u3]);
    expect(await queueIds({ region: "Helsinki" })).toEqual([u4]);
    expect(await queueIds({ region: "Kainuu", regionItemKey: "current_region" })).toEqual([]);
  });

  it("paginates on the server and gives stable neighbors across page borders", async () => {
    const all = await queueIds({ modes: ["research", "test", "demo"] });
    expect(all).toHaveLength(7);

    const page1 = await listReviewQueue(t.adminCtx, { modes: ["research", "test", "demo"] }, { page: 1, pageSize: 3 });
    const page2 = await listReviewQueue(t.adminCtx, { modes: ["research", "test", "demo"] }, { page: 2, pageSize: 3 });
    const page3 = await listReviewQueue(t.adminCtx, { modes: ["research", "test", "demo"] }, { page: 3, pageSize: 3 });
    expect(page1.total).toBe(7);
    expect(page1.rows.map((row) => row.utteranceId)).toEqual(all.slice(0, 3));
    expect(page2.rows.map((row) => row.utteranceId)).toEqual(all.slice(3, 6));
    expect(page3.rows.map((row) => row.utteranceId)).toEqual(all.slice(6));

    expect(page1.rows[0]).toMatchObject({ previousId: null, nextId: all[1] });
    expect(page1.rows[2]).toMatchObject({ previousId: all[1], nextId: all[3] });
    expect(page2.rows[0]).toMatchObject({ previousId: all[2], nextId: all[4] });
    expect(page2.rows[2]).toMatchObject({ previousId: all[4], nextId: all[6] });
    expect(page3.rows[0]).toMatchObject({ previousId: all[5], nextId: null });

    const beyond = await listReviewQueue(t.adminCtx, {}, { page: 9, pageSize: 3 });
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(5);
  });

  it("rejects an unknown condition and a page size above the limit", async () => {
    await expect(
      // @ts-expect-error not a queue condition
      listReviewQueue(t.adminCtx, { conditions: ["dialect_score"] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(listReviewQueue(t.adminCtx, {}, { pageSize: 5000 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
