import { and, asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminAuditLog,
  differenceAnnotations,
  researchFlags,
  researchNotes,
  transcriptRevisions,
  transcripts,
} from "@dialect/db";
import {
  insertSessionWithUtterance,
  insertStudy,
  insertTranscriptWithRevision,
  type CollectedSession,
} from "@dialect/db/testing-builders";
import { AppError, transcriptSchemas } from "@dialect/domain";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  addFlag,
  addNote,
  getTranscriptHistory,
  getUtteranceForReview,
  resolveFlag,
  saveDifferenceAnnotation,
  saveRevisionForTranscript,
  saveTranscriptRevision,
  setTranscriptStatus,
  verifyTranscript,
} from "./index";

let t: TestServiceContext;
let studyId: string;

beforeAll(async () => {
  t = await createTestServiceContext();
  const study = await insertStudy(t.testDb.db, {
    settingsJson: {
      transcriptionConventionVersion: "conv-2.1",
      annotationSchemeVersion: "scheme-1.3",
      adminTimezone: "Europe/Helsinki",
    },
  });
  studyId = study.id;
});

afterAll(async () => {
  await t.cleanup();
});

let protocolVersionId: string | undefined;

// Each test works on its own utterance, in the shared study and protocol.
async function newUtterance(): Promise<CollectedSession> {
  const collected = await insertSessionWithUtterance(t.testDb.db, { studyId, protocolVersionId });
  protocolVersionId = collected.protocol.id;
  return collected;
}

async function expectAppError(run: () => Promise<unknown>, code: string): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`Expected an AppError with the code ${code}`);
}

async function revisionsOf(transcriptId: string) {
  return t.testDb.db
    .select()
    .from(transcriptRevisions)
    .where(eq(transcriptRevisions.transcriptId, transcriptId))
    .orderBy(asc(transcriptRevisions.revisionNumber));
}

async function auditFor(entityId: string) {
  return t.testDb.db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.entityId, entityId))
    .orderBy(asc(adminAuditLog.createdAt), asc(adminAuditLog.id));
}

describe("saveTranscriptRevision", () => {
  it("creates the transcript and revision 1 on the first save", async () => {
    const { utterance } = await newUtterance();
    const result = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "human_dialect",
      text: "Mie en oikeestaan tiiä.",
      annotatorLabel: "annotator-1",
    });

    expect(result.created).toBe(true);
    expect(result.transcript).toMatchObject({ type: "human_dialect", status: "draft", revisionCount: 1 });
    expect(result.revision).toMatchObject({
      revisionNumber: 1,
      text: "Mie en oikeestaan tiiä.",
      isCurrent: true,
      createdByType: "researcher",
      createdByLabel: "annotator-1",
      transcriptionConventionVersion: "conv-2.1",
      changeReason: null,
      verifiedAt: null,
      derivedFromRevisionId: null,
    });
    expect(result.revision.createdAt).toBe(t.clock.now().toISOString());

    const audit = await auditFor(result.transcript.id);
    expect(audit.map((row) => row.action)).toEqual(["transcript.save_revision"]);
    expect(audit[0]?.actorLabel).toBe("annotator-1");
    // The audit row points at the revision. It does not copy the transcript text.
    expect(JSON.stringify(audit[0])).not.toContain("oikeestaan");
  });

  it("falls back to the actor label when no annotator label is given", async () => {
    const { utterance } = await newUtterance();
    const result = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "normalized",
      text: "Minä en oikeastaan tiedä.",
    });
    expect(result.revision.createdByLabel).toBe("admin");
  });

  it("creates revision 2 on the second save and leaves revision 1 untouched", async () => {
    const { utterance } = await newUtterance();
    const first = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "human_dialect",
      text: "Mie en tiiä.",
    });
    const before = (await revisionsOf(first.transcript.id))[0];
    t.clock.advance(60_000);
    const second = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "human_dialect",
      text: "Mie en oikeestaan tiiä.",
    });

    expect(second.created).toBe(true);
    expect(second.transcript.id).toBe(first.transcript.id);
    expect(second.revision.revisionNumber).toBe(2);
    const rows = await revisionsOf(first.transcript.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ ...before, isCurrent: false });
    expect(rows[1]).toMatchObject({ revisionNumber: 2, isCurrent: true, text: "Mie en oikeestaan tiiä." });
  });

  it("writes nothing when the text is identical to the current revision", async () => {
    const { utterance } = await newUtterance();
    const first = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "asr_corrected",
      text: "Sama teksti.",
    });
    const again = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "asr_corrected",
      text: "Sama teksti.",
    });
    expect(again.created).toBe(false);
    expect(again.revision.id).toBe(first.revision.id);
    expect(await revisionsOf(first.transcript.id)).toHaveLength(1);
    expect(await auditFor(first.transcript.id)).toHaveLength(1);
  });

  it("stores the text exactly as entered", async () => {
    const { utterance } = await newUtterance();
    const text = "  mie  niinku...\n\ttoinen rivi ";
    const result = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text });
    expect(result.revision.text).toBe(text);
  });

  it("rejects the ASR type: ASR revisions come only from the processing pipeline", async () => {
    const { utterance } = await newUtterance();
    await expectAppError(
      () =>
        saveTranscriptRevision(t.adminCtx, {
          utteranceId: utterance.id,
          // @ts-expect-error the type does not allow "asr"
          type: "asr",
          text: "Minä en tiedä.",
        }),
      "VALIDATION_ERROR",
    );
    expect(await t.testDb.db.select().from(transcripts).where(eq(transcripts.utteranceId, utterance.id))).toHaveLength(0);
  });

  it("does not add a revision to an ASR transcript addressed by its id", async () => {
    const { utterance } = await newUtterance();
    const asr = await insertTranscriptWithRevision(t.testDb.db, { utteranceId: utterance.id, type: "asr", text: "Minä en tiedä." });
    await expectAppError(
      () => saveRevisionForTranscript(t.adminCtx, { transcriptId: asr.transcript.id, text: "Muutettu." }),
      "IMMUTABLE_RECORD",
    );
    const rows = await revisionsOf(asr.transcript.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("Minä en tiedä.");
  });

  it("rejects an empty text, an unknown utterance and an utterance without a submitted recording", async () => {
    const { utterance } = await newUtterance();
    await expectAppError(
      () => saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "  \n " }),
      "VALIDATION_ERROR",
    );
    await expectAppError(
      () =>
        saveTranscriptRevision(t.adminCtx, {
          utteranceId: "00000000-0000-4000-8000-000000000000",
          type: "human_dialect",
          text: "Teksti.",
        }),
      "NOT_FOUND",
    );
    const recording = await insertSessionWithUtterance(t.testDb.db, {
      studyId,
      protocolVersionId,
      utterance: { status: "uploading" },
    });
    await expectAppError(
      () => saveTranscriptRevision(t.adminCtx, { utteranceId: recording.utterance.id, type: "human_dialect", text: "Teksti." }),
      "INVALID_STATE",
    );
  });

  it("sets needs_review when a second review is asked for", async () => {
    const { utterance } = await newUtterance();
    const result = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "human_dialect",
      text: "Mie en tiiä.",
      needsReview: true,
    });
    expect(result.transcript.status).toBe("needs_review");
  });

  it("records the revision a copied text was derived from, and only from the allowed source", async () => {
    const { utterance } = await newUtterance();
    const asr = await insertTranscriptWithRevision(t.testDb.db, { utteranceId: utterance.id, type: "asr", text: "Minä en tiedä." });
    const corrected = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "asr_corrected",
      text: "Minä en tiedä!",
      derivedFromRevisionId: asr.revision.id,
    });
    expect(corrected.revision.derivedFromRevisionId).toBe(asr.revision.id);

    // B is transcribed from the audio: it is never derived from ASR.
    await expectAppError(
      () =>
        saveTranscriptRevision(t.adminCtx, {
          utteranceId: utterance.id,
          type: "human_dialect",
          text: "Mie en tiiä.",
          derivedFromRevisionId: asr.revision.id,
        }),
      "VALIDATION_ERROR",
    );
    const b = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä." });

    // C may be derived from B, not from ASR.
    await expectAppError(
      () =>
        saveTranscriptRevision(t.adminCtx, {
          utteranceId: utterance.id,
          type: "normalized",
          text: "Minä en tiedä.",
          derivedFromRevisionId: asr.revision.id,
        }),
      "VALIDATION_ERROR",
    );
    const c = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "normalized",
      text: "Minä en tiedä.",
      derivedFromRevisionId: b.revision.id,
    });
    expect(c.revision.derivedFromRevisionId).toBe(b.revision.id);

    // A revision of another utterance is not accepted.
    const other = await newUtterance();
    const otherB = await insertTranscriptWithRevision(t.testDb.db, { utteranceId: other.utterance.id, type: "human_dialect" });
    await expectAppError(
      () =>
        saveTranscriptRevision(t.adminCtx, {
          utteranceId: utterance.id,
          type: "normalized",
          text: "Toinen teksti.",
          derivedFromRevisionId: otherB.revision.id,
        }),
      "VALIDATION_ERROR",
    );
  });

  it("lets the review screen tell when C is based on an older B (the read model carries what the check needs)", async () => {
    const { utterance } = await newUtterance();
    const check = async () => {
      const review = await getUtteranceForReview(t.adminCtx, utterance.id);
      return transcriptSchemas.normalizedDerivationWarning(
        review.transcripts.human_dialect?.currentRevision,
        review.transcripts.normalized?.currentRevision,
      );
    };
    const b1 = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä." });
    await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "normalized",
      text: "Minä en tiedä.",
      derivedFromRevisionId: b1.revision.id,
    });
    expect(await check()).toBeNull();

    // B changes: C still records the earlier B revision.
    t.clock.advance(60_000);
    await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä sitä." });
    expect((await check())?.kind).toBe("derived_from_older_revision");

    // C typed by hand afterwards: no derivation recorded, and it is newer than B.
    t.clock.advance(60_000);
    await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "normalized", text: "Minä en tiedä sitä." });
    expect(await check()).toBeNull();

    // B changes again after the hand-typed C.
    t.clock.advance(60_000);
    await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä sitä ollenkaa." });
    const warning = await check();
    expect(warning?.kind).toBe("source_changed_later");
    expect(warning?.message).toContain("B was changed (revision 3) after C revision 2 was saved");
  });

  it("rejects a save that was based on an older revision when the editor says which one it loaded", async () => {
    const { utterance } = await newUtterance();
    const first = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Yksi." });
    await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Kaksi." });
    const error = await expectAppError(
      () =>
        saveTranscriptRevision(t.adminCtx, {
          utteranceId: utterance.id,
          type: "human_dialect",
          text: "Kolme.",
          expectedCurrentRevisionId: first.revision.id,
        }),
      "CONFLICT",
    );
    expect(error.httpStatus).toBe(409);
    expect(await revisionsOf(first.transcript.id)).toHaveLength(2);
  });

  it("produces exactly one current revision when several researchers save at once", async () => {
    const { utterance } = await newUtterance();
    const texts = ["Yksi.", "Kaksi.", "Kolme.", "Neljä.", "Viisi.", "Kuusi."];
    const results = await Promise.all(
      texts.map((text, index) =>
        saveTranscriptRevision(
          { ...t.adminCtx, actorLabel: `annotator-${index}` },
          { utteranceId: utterance.id, type: "human_dialect", text },
        ),
      ),
    );
    expect(new Set(results.map((result) => result.transcript.id)).size).toBe(1);
    const transcriptRows = await t.testDb.db.select().from(transcripts).where(eq(transcripts.utteranceId, utterance.id));
    expect(transcriptRows).toHaveLength(1);
    const rows = await revisionsOf(results[0]!.transcript.id);
    expect(rows.map((row) => row.revisionNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.filter((row) => row.isCurrent)).toHaveLength(1);
    expect(rows[5]?.isCurrent).toBe(true);
    expect(rows.map((row) => row.text).sort()).toEqual([...texts].sort());
  });
});

describe("verifyTranscript", () => {
  it("sets the verification fields on the current revision and the status verified", async () => {
    const { utterance } = await newUtterance();
    const saved = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä." });
    t.clock.advance(5_000);
    const result = await verifyTranscript(t.adminCtx, {
      transcriptId: saved.transcript.id,
      revisionId: saved.revision.id,
      verificationNotes: "Checked against the audio twice.",
      verifiedByLabel: "annotator-2",
    });

    expect(result.transcript.status).toBe("verified");
    expect(result.revision).toMatchObject({
      id: saved.revision.id,
      text: "Mie en tiiä.",
      verifiedAt: t.clock.now().toISOString(),
      verifiedByLabel: "annotator-2",
      verificationNotes: "Checked against the audio twice.",
      isCurrent: true,
    });
    const audit = await auditFor(saved.transcript.id);
    expect(audit.map((row) => row.action)).toEqual(["transcript.save_revision", "transcript.verify"]);
    expect(audit[1]?.actorLabel).toBe("annotator-2");
  });

  it("rejects a stale revision id: someone else saved in between", async () => {
    const { utterance } = await newUtterance();
    const first = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Yksi." });
    const second = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Kaksi." });
    const error = await expectAppError(
      () => verifyTranscript(t.adminCtx, { transcriptId: first.transcript.id, revisionId: first.revision.id }),
      "CONFLICT",
    );
    expect(error.details).toEqual({ currentRevisionId: second.revision.id });
    const rows = await revisionsOf(first.transcript.id);
    expect(rows.every((row) => row.verifiedAt === null)).toBe(true);
    const [transcript] = await t.testDb.db.select().from(transcripts).where(eq(transcripts.id, first.transcript.id));
    expect(transcript?.status).toBe("draft");
  });

  it("is repeatable, and rejects an ASR transcript and an unknown transcript", async () => {
    const { utterance } = await newUtterance();
    const saved = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "normalized", text: "Minä en tiedä." });
    const once = await verifyTranscript(t.adminCtx, { transcriptId: saved.transcript.id, revisionId: saved.revision.id });
    t.clock.advance(60_000);
    const twice = await verifyTranscript(t.adminCtx, { transcriptId: saved.transcript.id, revisionId: saved.revision.id });
    expect(twice.revision.verifiedAt).toBe(once.revision.verifiedAt);
    expect((await auditFor(saved.transcript.id)).filter((row) => row.action === "transcript.verify")).toHaveLength(1);

    const asr = await insertTranscriptWithRevision(t.testDb.db, { utteranceId: utterance.id, type: "asr" });
    await expectAppError(
      () => verifyTranscript(t.adminCtx, { transcriptId: asr.transcript.id, revisionId: asr.revision.id }),
      "INVALID_STATE",
    );
    await expectAppError(
      () =>
        verifyTranscript(t.adminCtx, {
          transcriptId: "00000000-0000-4000-8000-000000000000",
          revisionId: saved.revision.id,
        }),
      "NOT_FOUND",
    );
  });
});

describe("revising a verified transcript", () => {
  it("requires a change reason, then creates a new revision, resets the status and audits", async () => {
    const { utterance } = await newUtterance();
    const saved = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä." });
    await verifyTranscript(t.adminCtx, { transcriptId: saved.transcript.id, revisionId: saved.revision.id });
    const verifiedRow = (await revisionsOf(saved.transcript.id))[0];

    const error = await expectAppError(
      () => saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en oikeestaan tiiä." }),
      "VALIDATION_ERROR",
    );
    expect(error.details).toEqual({
      issues: [{ path: "changeReason", message: "A change reason is required for a verified transcript." }],
    });
    // A reason made of spaces only is no reason.
    await expectAppError(
      () =>
        saveTranscriptRevision(t.adminCtx, {
          utteranceId: utterance.id,
          type: "human_dialect",
          text: "Mie en oikeestaan tiiä.",
          changeReason: "   ",
        }),
      "VALIDATION_ERROR",
    );
    expect(await revisionsOf(saved.transcript.id)).toHaveLength(1);

    // The identical text is still a no-op and needs no reason.
    const same = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä." });
    expect(same.created).toBe(false);
    expect(same.transcript.status).toBe("verified");

    const revised = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "human_dialect",
      text: "Mie en oikeestaan tiiä.",
      changeReason: "Missed a word on the first pass.",
    });
    expect(revised.created).toBe(true);
    expect(revised.transcript.status).toBe("draft");
    expect(revised.revision).toMatchObject({
      revisionNumber: 2,
      changeReason: "Missed a word on the first pass.",
      verifiedAt: null,
      isCurrent: true,
    });

    // The verified revision is still there, exactly as it was, apart from is_current.
    const rows = await revisionsOf(saved.transcript.id);
    expect(rows[0]).toEqual({ ...verifiedRow, isCurrent: false });
    expect(rows[0]?.verifiedAt).not.toBeNull();

    const audit = await auditFor(saved.transcript.id);
    expect(audit.map((row) => row.action)).toEqual([
      "transcript.save_revision",
      "transcript.verify",
      "transcript.revise_verified",
    ]);
    expect(audit[2]?.beforeJson).toMatchObject({ status: "verified", currentRevisionId: saved.revision.id });
    expect(audit[2]?.afterJson).toMatchObject({
      status: "draft",
      currentRevisionId: revised.revision.id,
      changeReason: "Missed a word on the first pass.",
    });
  });

  it("can go straight to needs_review", async () => {
    const { utterance } = await newUtterance();
    const saved = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "normalized", text: "Yksi." });
    await verifyTranscript(t.adminCtx, { transcriptId: saved.transcript.id, revisionId: saved.revision.id });
    const revised = await saveTranscriptRevision(t.adminCtx, {
      utteranceId: utterance.id,
      type: "normalized",
      text: "Kaksi.",
      changeReason: "Second reviewer disagrees.",
      needsReview: true,
    });
    expect(revised.transcript.status).toBe("needs_review");
  });
});

describe("setTranscriptStatus", () => {
  it("moves a draft to needs_review and back, and refuses a verified transcript", async () => {
    const { utterance } = await newUtterance();
    const saved = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä." });
    const asked = await setTranscriptStatus(t.adminCtx, { transcriptId: saved.transcript.id, status: "needs_review" });
    expect(asked.transcript.status).toBe("needs_review");
    const back = await setTranscriptStatus(t.adminCtx, { transcriptId: saved.transcript.id, status: "draft" });
    expect(back.transcript.status).toBe("draft");
    expect(await revisionsOf(saved.transcript.id)).toHaveLength(1);
    const audit = await auditFor(saved.transcript.id);
    expect(audit.map((row) => row.action)).toEqual([
      "transcript.save_revision",
      "transcript.set_status",
      "transcript.set_status",
    ]);
    expect(audit[1]).toMatchObject({
      beforeJson: { status: "draft", currentRevisionId: saved.revision.id },
      afterJson: { status: "needs_review", currentRevisionId: saved.revision.id },
    });

    await verifyTranscript(t.adminCtx, { transcriptId: saved.transcript.id, revisionId: saved.revision.id });
    await expectAppError(
      () => setTranscriptStatus(t.adminCtx, { transcriptId: saved.transcript.id, status: "needs_review" }),
      "INVALID_STATE",
    );
    await expectAppError(
      // @ts-expect-error verified is set only by verifyTranscript
      () => setTranscriptStatus(t.adminCtx, { transcriptId: saved.transcript.id, status: "verified" }),
      "VALIDATION_ERROR",
    );
  });
});

describe("getTranscriptHistory", () => {
  it("returns all revisions, newest first", async () => {
    const { utterance } = await newUtterance();
    let transcriptId = "";
    for (const text of ["Yksi.", "Kaksi.", "Kolme."]) {
      t.clock.advance(1_000);
      transcriptId = (await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text }))
        .transcript.id;
    }
    const history = await getTranscriptHistory(t.adminCtx, transcriptId);
    expect(history.transcript.revisionCount).toBe(3);
    expect(history.revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    expect(history.revisions.map((revision) => revision.text)).toEqual(["Kolme.", "Kaksi.", "Yksi."]);
    expect(history.revisions.map((revision) => revision.isCurrent)).toEqual([true, false, false]);
    await expectAppError(() => getTranscriptHistory(t.adminCtx, "00000000-0000-4000-8000-000000000000"), "NOT_FOUND");
  });
});

describe("saveDifferenceAnnotation", () => {
  async function utteranceWithAAndB() {
    const { utterance } = await newUtterance();
    const a = await insertTranscriptWithRevision(t.testDb.db, { utteranceId: utterance.id, type: "asr", text: "Minä en tiedä." });
    const b = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä." });
    return { utterance, a: a.revision, b: b.revision };
  }

  it("accepts several categories and stores the scheme version from the study settings", async () => {
    const { utterance, a, b } = await utteranceWithAAndB();
    const { annotation } = await saveDifferenceAnnotation(t.adminCtx, {
      utteranceId: utterance.id,
      sourceTranscriptRevisionId: a.id,
      targetTranscriptRevisionId: b.id,
      categories: ["normalization", "recognition_error", "normalization"],
      notes: "mie became minä",
      annotatorLabel: "annotator-1",
      scope: "utterance",
    });
    expect(annotation).toMatchObject({
      categories: ["normalization", "recognition_error"],
      schemeVersion: "scheme-1.3",
      annotatorLabel: "annotator-1",
      scope: "utterance",
      sourceTranscriptType: "asr",
      targetTranscriptType: "human_dialect",
      sourceRevisionNumber: 1,
      targetRevisionNumber: 1,
      notes: "mie became minä",
    });
    const audit = await auditFor(annotation.id);
    expect(audit.map((row) => row.action)).toEqual(["annotation.create"]);
  });

  it("never overwrites: a second save adds a row and independent ratings are kept", async () => {
    const { utterance, a, b } = await utteranceWithAAndB();
    const base = {
      utteranceId: utterance.id,
      sourceTranscriptRevisionId: a.id,
      targetTranscriptRevisionId: b.id,
      scope: "utterance" as const,
    };
    t.clock.advance(1_000);
    const first = await saveDifferenceAnnotation(t.adminCtx, { ...base, categories: ["normalization"], annotatorLabel: "annotator-1" });
    t.clock.advance(1_000);
    const other = await saveDifferenceAnnotation(t.adminCtx, { ...base, categories: ["omission", "uncertain"], annotatorLabel: "annotator-2" });
    t.clock.advance(1_000);
    const second = await saveDifferenceAnnotation(t.adminCtx, { ...base, categories: ["normalization", "segmentation"], annotatorLabel: "annotator-1" });

    const rows = await t.testDb.db
      .select()
      .from(differenceAnnotations)
      .where(eq(differenceAnnotations.utteranceId, utterance.id))
      .orderBy(asc(differenceAnnotations.createdAt));
    expect(rows.map((row) => row.id)).toEqual([first.annotation.id, other.annotation.id, second.annotation.id]);
    expect(rows[0]?.categoriesJson).toEqual(["normalization"]);

    const review = await getUtteranceForReview(t.adminCtx, utterance.id);
    expect(review.differenceAnnotations.history.map((row) => row.id)).toEqual([
      second.annotation.id,
      other.annotation.id,
      first.annotation.id,
    ]);
    expect(review.differenceAnnotations.latest.map((row) => [row.annotatorLabel, row.categories])).toEqual([
      ["annotator-1", ["normalization", "segmentation"]],
      ["annotator-2", ["omission", "uncertain"]],
    ]);
  });

  it("supports span offsets and validates them", async () => {
    const { utterance, a, b } = await utteranceWithAAndB();
    const base = { utteranceId: utterance.id, sourceTranscriptRevisionId: a.id, targetTranscriptRevisionId: b.id };
    const { annotation } = await saveDifferenceAnnotation(t.adminCtx, {
      ...base,
      categories: ["normalization"],
      scope: "span",
      sourceStart: 0,
      sourceEnd: 4,
      targetStart: 0,
      targetEnd: 3,
    });
    expect(annotation).toMatchObject({ scope: "span", sourceStart: 0, sourceEnd: 4, targetStart: 0, targetEnd: 3 });

    await expectAppError(
      () => saveDifferenceAnnotation(t.adminCtx, { ...base, categories: [], scope: "span" }),
      "VALIDATION_ERROR",
    );
    await expectAppError(
      () => saveDifferenceAnnotation(t.adminCtx, { ...base, categories: [], scope: "span", sourceStart: 5, sourceEnd: 2 }),
      "VALIDATION_ERROR",
    );
    await expectAppError(
      () => saveDifferenceAnnotation(t.adminCtx, { ...base, categories: [], scope: "span", sourceStart: 0, sourceEnd: 999 }),
      "VALIDATION_ERROR",
    );
    await expectAppError(
      () => saveDifferenceAnnotation(t.adminCtx, { ...base, categories: [], scope: "utterance", sourceStart: 0, sourceEnd: 2 }),
      "VALIDATION_ERROR",
    );
  });

  it("rejects an unknown category, revisions of another utterance and a missing scheme version", async () => {
    const { utterance, a, b } = await utteranceWithAAndB();
    const base = { utteranceId: utterance.id, sourceTranscriptRevisionId: a.id, targetTranscriptRevisionId: b.id, scope: "utterance" as const };
    await expectAppError(
      // @ts-expect-error not a category of the scheme
      () => saveDifferenceAnnotation(t.adminCtx, { ...base, categories: ["dialect_loss"] }),
      "VALIDATION_ERROR",
    );
    const other = await utteranceWithAAndB();
    await expectAppError(
      () => saveDifferenceAnnotation(t.adminCtx, { ...base, targetTranscriptRevisionId: other.b.id, categories: ["omission"] }),
      "VALIDATION_ERROR",
    );
    await expectAppError(
      () => saveDifferenceAnnotation(t.adminCtx, { ...base, targetTranscriptRevisionId: a.id, categories: ["omission"] }),
      "VALIDATION_ERROR",
    );

    // A study without an annotation scheme version cannot be coded.
    const bare = await insertSessionWithUtterance(t.testDb.db);
    const bareA = await insertTranscriptWithRevision(t.testDb.db, { utteranceId: bare.utterance.id, type: "asr" });
    const bareB = await insertTranscriptWithRevision(t.testDb.db, { utteranceId: bare.utterance.id, type: "human_dialect" });
    await expectAppError(
      () =>
        saveDifferenceAnnotation(t.adminCtx, {
          utteranceId: bare.utterance.id,
          sourceTranscriptRevisionId: bareA.revision.id,
          targetTranscriptRevisionId: bareB.revision.id,
          categories: ["omission"],
          scope: "utterance",
        }),
      "CONFIGURATION_MISSING",
    );
  });
});

describe("flags and notes", () => {
  it("adds a flag with a reason code to an utterance and resolves it once", async () => {
    const { utterance } = await newUtterance();
    const { flag } = await addFlag(t.adminCtx, {
      entityType: "utterance",
      entityId: utterance.id,
      reasonCode: "contains_third_party_identifier",
      notes: "Mentions a neighbor by full name.",
      annotatorLabel: "annotator-1",
    });
    expect(flag).toMatchObject({
      entityType: "utterance",
      entityId: utterance.id,
      reasonCode: "contains_third_party_identifier",
      createdByLabel: "annotator-1",
      resolvedAt: null,
      transcriptType: null,
    });

    t.clock.advance(10_000);
    const resolved = await resolveFlag(t.adminCtx, { flagId: flag.id });
    expect(resolved.flag.resolvedAt).toBe(t.clock.now().toISOString());
    t.clock.advance(10_000);
    const again = await resolveFlag(t.adminCtx, { flagId: flag.id });
    expect(again.flag.resolvedAt).toBe(resolved.flag.resolvedAt);

    const audit = await auditFor(utterance.id);
    expect(audit.map((row) => row.action)).toEqual(["flag.create", "flag.resolve"]);
    // The row is kept after it is resolved.
    expect(await t.testDb.db.select().from(researchFlags).where(eq(researchFlags.id, flag.id))).toHaveLength(1);
  });

  it("flags and annotates a transcript, and shows both on the review screen", async () => {
    const { utterance } = await newUtterance();
    const b = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä." });
    const { flag } = await addFlag(t.adminCtx, {
      entityType: "transcript",
      entityId: b.transcript.id,
      reasonCode: "needs_expert_review",
      utteranceId: utterance.id,
    });
    expect(flag.transcriptType).toBe("human_dialect");
    t.clock.advance(1_000);
    await addNote(t.adminCtx, { entityType: "utterance", entityId: utterance.id, body: "Background noise from 0:03." });
    t.clock.advance(1_000);
    const { note } = await addNote(t.adminCtx, {
      entityType: "transcript",
      entityId: b.transcript.id,
      body: "Unsure about the second word.",
      annotatorLabel: "annotator-2",
    });
    expect(note).toMatchObject({ transcriptType: "human_dialect", createdByLabel: "annotator-2" });

    const review = await getUtteranceForReview(t.adminCtx, utterance.id);
    expect(review.flags.map((row) => row.id)).toEqual([flag.id]);
    expect(review.notes.map((row) => row.body)).toEqual(["Unsure about the second word.", "Background noise from 0:03."]);
    // The note text is not copied into the audit log.
    const noteAudit = (await auditFor(b.transcript.id)).find((row) => row.action === "note.create");
    expect(JSON.stringify(noteAudit)).not.toContain("Unsure");
    expect(await t.testDb.db.select().from(researchNotes).where(eq(researchNotes.entityId, utterance.id))).toHaveLength(1);
  });

  it("rejects an unknown reason code, a missing entity and a transcript of another utterance", async () => {
    const { utterance } = await newUtterance();
    const other = await newUtterance();
    const otherB = await insertTranscriptWithRevision(t.testDb.db, { utteranceId: other.utterance.id });
    await expectAppError(
      // @ts-expect-error not a reason code
      () => addFlag(t.adminCtx, { entityType: "utterance", entityId: utterance.id, reasonCode: "boring" }),
      "VALIDATION_ERROR",
    );
    await expectAppError(
      () =>
        addFlag(t.adminCtx, {
          entityType: "utterance",
          entityId: "00000000-0000-4000-8000-000000000000",
          reasonCode: "other",
        }),
      "NOT_FOUND",
    );
    await expectAppError(
      () =>
        addFlag(t.adminCtx, {
          entityType: "transcript",
          entityId: otherB.transcript.id,
          reasonCode: "other",
          utteranceId: utterance.id,
        }),
      "VALIDATION_ERROR",
    );
    await expectAppError(() => addNote(t.adminCtx, { entityType: "utterance", entityId: utterance.id, body: "  " }), "VALIDATION_ERROR");
    await expectAppError(() => resolveFlag(t.adminCtx, { flagId: "00000000-0000-4000-8000-000000000000" }), "NOT_FOUND");

    // A flag on a session belongs to another service and is not resolved here.
    const [sessionFlag] = await t.testDb.db
      .insert(researchFlags)
      .values({ entityType: "session", entityId: other.session.id, reasonCode: "other" })
      .returning();
    await expectAppError(() => resolveFlag(t.adminCtx, { flagId: sessionFlag!.id }), "NOT_FOUND");
  });
});

describe("getUtteranceForReview", () => {
  it("returns the utterance with session, task, exact prompt, media, the four transcripts and settings", async () => {
    const collected = await newUtterance();
    const { utterance, session, media, presentation } = collected;
    const asr = await insertTranscriptWithRevision(t.testDb.db, { utteranceId: utterance.id, type: "asr", text: "Minä en tiedä." });
    const b1 = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä" });
    const b2 = await saveTranscriptRevision(t.adminCtx, { utteranceId: utterance.id, type: "human_dialect", text: "Mie en tiiä." });

    const review = await getUtteranceForReview(t.adminCtx, utterance.id);
    expect(review.utterance).toMatchObject({
      id: utterance.id,
      status: "submitted",
      promptSnapshot: presentation.promptSnapshot,
      isFollowup: false,
    });
    expect(review.session).toMatchObject({
      id: session.id,
      participantCode: session.participantCode,
      mode: "research",
      protocolVersionNumber: collected.protocol.versionNumber,
    });
    expect(review.task).toMatchObject({
      taskType: "controlled",
      taskKey: "controlled_1",
      promptSnapshot: "Test prompt for a controlled task.",
    });
    expect(review.media).toMatchObject({
      id: media.id,
      mimeType: "audio/wav",
      sampleRateHz: 48000,
      sha256: media.sha256,
      deleted: false,
    });
    expect(review.transcripts.asr).toMatchObject({ status: "draft", revisionCount: 1 });
    expect(review.transcripts.asr?.currentRevision?.id).toBe(asr.revision.id);
    expect(review.transcripts.human_dialect).toMatchObject({ id: b1.transcript.id, revisionCount: 2, status: "draft" });
    expect(review.transcripts.human_dialect?.currentRevision?.id).toBe(b2.revision.id);
    expect(review.transcripts.asr_corrected).toBeNull();
    expect(review.transcripts.normalized).toBeNull();
    expect(review.settings).toEqual({
      adminTimezone: "Europe/Helsinki",
      transcriptionConventionVersion: "conv-2.1",
      annotationSchemeVersion: "scheme-1.3",
    });
    expect(review.differenceAnnotations).toEqual({ latest: [], history: [] });

    await expectAppError(() => getUtteranceForReview(t.adminCtx, "00000000-0000-4000-8000-000000000000"), "NOT_FOUND");
    await expectAppError(() => getUtteranceForReview(t.adminCtx, "not-an-id"), "VALIDATION_ERROR");
  });

  it("never leaves two current revisions in the table", async () => {
    const duplicates = await t.testDb.db
      .select({ transcriptId: transcriptRevisions.transcriptId })
      .from(transcriptRevisions)
      .where(and(eq(transcriptRevisions.isCurrent, true)))
      .orderBy(desc(transcriptRevisions.transcriptId));
    expect(new Set(duplicates.map((row) => row.transcriptId)).size).toBe(duplicates.length);
  });
});
