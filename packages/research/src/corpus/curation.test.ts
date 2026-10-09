import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminAuditLog,
  mediaAssets,
  researchFlags,
  researchNotes,
  sessions,
  syntheses,
  translations,
  utterances,
} from "@dialect/db";
import { insertSessionWithUtterance, type CollectedSession } from "@dialect/db/testing-builders";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { getAuditHistory, getSessionAuditHistory } from "./audit-history";
import {
  addNote,
  excludeSession,
  excludeUtterance,
  includeSession,
  includeUtterance,
  setOutputStatus,
  setSessionFlag,
  setUtteranceFlag,
} from "./curation";
import { getSessionDetail } from "./session-detail";
import { listSessions } from "./sessions-list";
import { processUtterance, type ProcessedUtterance } from "./test-helpers";

let t: TestServiceContext;
let collected: CollectedSession;
let processed: ProcessedUtterance;
let other: CollectedSession;

const MISSING = "00000000-0000-4000-8000-000000000000";

async function auditFor(entityId: string): Promise<Array<{ action: string; before: unknown; after: unknown; actor: string | null }>> {
  const rows = await t.ctx.db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.entityId, entityId))
    .orderBy(asc(adminAuditLog.createdAt), asc(adminAuditLog.id));
  return rows.map((row) => ({ action: row.action, before: row.beforeJson, after: row.afterJson, actor: row.actorLabel }));
}

beforeAll(async () => {
  t = await createTestServiceContext();
  collected = await insertSessionWithUtterance(t.ctx.db, { session: { status: "completed" } });
  processed = await processUtterance(t.ctx.db, {
    studyId: collected.study.id,
    utteranceId: collected.utterance.id,
    batchNames: ["pilot-v1"],
  });
  other = await insertSessionWithUtterance(t.ctx.db, {
    studyId: collected.study.id,
    protocolVersionId: collected.protocol.id,
  });
});

afterAll(async () => {
  await t.cleanup();
});

describe("flags", () => {
  it("flags a session without excluding it, keeps a history row and writes an audit row", async () => {
    const result = await setSessionFlag(t.adminCtx, {
      sessionId: collected.session.id,
      flagged: true,
      notes: "Background noise in every task",
      reasonCode: "poor_audio",
    });
    expect(result).toEqual({ id: collected.session.id, flagged: true, flagNotes: "Background noise in every task" });

    const [row] = await t.ctx.db.select().from(sessions).where(eq(sessions.id, collected.session.id));
    expect(row).toMatchObject({ flagged: true, flagNotes: "Background noise in every task", excluded: false, exclusionReason: null });
    const flags = await t.ctx.db.select().from(researchFlags).where(eq(researchFlags.entityId, collected.session.id));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entityType: "session", reasonCode: "poor_audio", resolvedAt: null, createdByLabel: "admin" });

    const audit = await auditFor(collected.session.id);
    expect(audit).toEqual([
      {
        action: "session.flag",
        before: { flagged: false, hasNotes: false },
        after: { flagged: true, hasNotes: true, reasonCode: "poor_audio" },
        actor: "admin",
      },
    ]);
    // The note text is not copied into the append-only audit log.
    expect(JSON.stringify(audit)).not.toContain("Background noise");
  });

  it("updates the open history row when the notes change, and resolves it when the flag is cleared", async () => {
    await setSessionFlag(t.adminCtx, { sessionId: collected.session.id, flagged: true, notes: "Noise in task 2 only" });
    let flags = await t.ctx.db.select().from(researchFlags).where(eq(researchFlags.entityId, collected.session.id));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ notes: "Noise in task 2 only", reasonCode: "poor_audio", resolvedAt: null });

    const cleared = await setSessionFlag(t.adminCtx, { sessionId: collected.session.id, flagged: false });
    expect(cleared).toEqual({ id: collected.session.id, flagged: false, flagNotes: null });
    flags = await t.ctx.db.select().from(researchFlags).where(eq(researchFlags.entityId, collected.session.id));
    expect(flags).toHaveLength(1);
    expect(flags[0]?.resolvedAt).not.toBeNull();
    expect((await auditFor(collected.session.id)).map((row) => row.action)).toEqual([
      "session.flag",
      "session.flag",
      "session.unflag",
    ]);
  });

  it("flags an utterance without changing its status", async () => {
    const result = await setUtteranceFlag(t.adminCtx, {
      sessionId: collected.session.id,
      utteranceId: collected.utterance.id,
      flagged: true,
      notes: "Mentions a neighbour by name",
      reasonCode: "contains_third_party_identifier",
    });
    expect(result.flagged).toBe(true);
    const [row] = await t.ctx.db.select().from(utterances).where(eq(utterances.id, collected.utterance.id));
    expect(row).toMatchObject({ flagged: true, status: "submitted", exclusionReason: null });
    expect((await auditFor(collected.utterance.id)).map((entry) => entry.action)).toEqual(["utterance.flag"]);

    // The flagged utterance is still part of the session counts.
    const list = await listSessions(t.adminCtx, { studyId: collected.study.id, flagged: true });
    expect(list.items.map((item) => item.id)).toEqual([collected.session.id]);
    expect(list.items[0]).toMatchObject({ utteranceCount: 1, flaggedUtterances: 1, excludedUtterances: 0 });
  });

  it("rejects an utterance of another session and an unknown session", async () => {
    await expect(
      setUtteranceFlag(t.adminCtx, { sessionId: other.session.id, utteranceId: collected.utterance.id, flagged: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setSessionFlag(t.adminCtx, { sessionId: MISSING, flagged: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("exclusion", () => {
  it("excludes and includes a session, keeping every row, and audits both", async () => {
    await expect(excludeSession(t.adminCtx, { sessionId: other.session.id, reason: "  " })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const excluded = await excludeSession(t.adminCtx, { sessionId: other.session.id, reason: "Participant is not a native speaker" });
    expect(excluded).toEqual({ id: other.session.id, excluded: true, exclusionReason: "Participant is not a native speaker" });

    // Nothing was deleted.
    const [utterance] = await t.ctx.db.select().from(utterances).where(eq(utterances.id, other.utterance.id));
    const [media] = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, other.media.id));
    expect(utterance).toMatchObject({ status: "submitted", acceptedMediaAssetId: other.media.id });
    expect(media?.deletedAt).toBeNull();
    expect((await listSessions(t.adminCtx, { studyId: collected.study.id, excluded: true })).items.map((item) => item.id)).toEqual([
      other.session.id,
    ]);

    const included = await includeSession(t.adminCtx, { sessionId: other.session.id });
    expect(included).toEqual({ id: other.session.id, excluded: false, exclusionReason: null });
    expect(await auditFor(other.session.id)).toEqual([
      {
        action: "session.exclude",
        before: { excluded: false, exclusionReason: null },
        after: { excluded: true, exclusionReason: "Participant is not a native speaker" },
        actor: "admin",
      },
      {
        action: "session.include",
        before: { excluded: true, exclusionReason: "Participant is not a native speaker" },
        after: { excluded: false, exclusionReason: null },
        actor: "admin",
      },
    ]);
  });

  it("excludes and includes an utterance, keeping the recording and the outputs", async () => {
    const excluded = await excludeUtterance(t.adminCtx, {
      sessionId: collected.session.id,
      utteranceId: collected.utterance.id,
      reason: "Recording contains only laughter",
    });
    expect(excluded).toEqual({ id: collected.utterance.id, status: "excluded", exclusionReason: "Recording contains only laughter" });

    const [row] = await t.ctx.db.select().from(utterances).where(eq(utterances.id, collected.utterance.id));
    expect(row).toMatchObject({ status: "excluded", acceptedMediaAssetId: collected.media.id });
    const detail = await getSessionDetail(t.adminCtx, collected.session.id);
    expect(detail.utterances[0]?.sourceMedia?.deletedAt).toBeNull();
    expect(detail.utterances[0]?.transcripts.filter((cell) => cell.current !== null)).toHaveLength(3);
    expect(detail.utterances[0]?.translationBatches[0]?.rows[2]?.cells[0]?.translations).toHaveLength(1);

    const included = await includeUtterance(t.adminCtx, { utteranceId: collected.utterance.id });
    expect(included).toEqual({ id: collected.utterance.id, status: "submitted", exclusionReason: null });
    const actions = (await auditFor(collected.utterance.id)).map((entry) => entry.action);
    expect(actions).toEqual(["utterance.flag", "utterance.exclude", "utterance.include"]);
  });

  it("only excludes an utterance that was submitted", async () => {
    const { utterance } = await insertSessionWithUtterance(t.ctx.db, {
      studyId: collected.study.id,
      protocolVersionId: collected.protocol.id,
      utterance: { status: "invalid" },
    });
    await expect(excludeUtterance(t.adminCtx, { utteranceId: utterance.id, reason: "x" })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(includeUtterance(t.adminCtx, { utteranceId: utterance.id })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
  });
});

describe("notes", () => {
  it("adds notes to a session, an utterance, a translation and a synthesis", async () => {
    const output = processed.batches[0]?.outputs[0];
    if (!output) throw new Error("missing output");
    const targets = [
      { entityType: "session" as const, entityId: collected.session.id },
      { entityType: "utterance" as const, entityId: collected.utterance.id },
      { entityType: "translation" as const, entityId: output.translation.id },
      { entityType: "synthesis" as const, entityId: output.synthesis.synthesis.id },
    ];
    for (const target of targets) {
      const note = await addNote(t.adminCtx, { ...target, body: `  Note on ${target.entityType}  ` });
      expect(note).toMatchObject({ ...target, body: `Note on ${target.entityType}`, createdByLabel: "admin" });
    }
    const rows = await t.ctx.db.select().from(researchNotes);
    expect(rows).toHaveLength(4);

    const detail = await getSessionDetail(t.adminCtx, collected.session.id);
    expect(detail.notes.map((note) => note.entityType).sort()).toEqual(["session", "synthesis", "translation", "utterance"]);
    // The audit row names the note, not its text.
    const audit = await auditFor(output.translation.id);
    expect(audit).toEqual([{ action: "note.create", before: null, after: { noteId: expect.any(String) }, actor: "admin" }]);
  });

  it("rejects an empty note and an unknown entity", async () => {
    await expect(addNote(t.adminCtx, { entityType: "session", entityId: collected.session.id, body: " " })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(addNote(t.adminCtx, { entityType: "translation", entityId: MISSING, body: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      addNote(t.adminCtx, { entityType: "utterance", entityId: collected.utterance.id, sessionId: other.session.id, body: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("output status", () => {
  it("changes only the status of a translation and records why", async () => {
    const output = processed.batches[0]?.outputs[1];
    if (!output) throw new Error("missing output");
    const [before] = await t.ctx.db.select().from(translations).where(eq(translations.id, output.translation.id));

    const result = await setOutputStatus(t.adminCtx, {
      entityType: "translation",
      entityId: output.translation.id,
      status: "excluded",
      reasonCode: "translation_problem",
      notes: "Meaning reversed",
    });
    expect(result).toEqual({ entityType: "translation", id: output.translation.id, status: "excluded" });

    const [after] = await t.ctx.db.select().from(translations).where(eq(translations.id, output.translation.id));
    expect(after).toEqual({ ...before, status: "excluded" });
    const [flag] = await t.ctx.db
      .select()
      .from(researchFlags)
      .where(and(eq(researchFlags.entityType, "translation"), eq(researchFlags.entityId, output.translation.id)));
    expect(flag).toMatchObject({ reasonCode: "translation_problem", notes: "Meaning reversed", resolvedAt: null });
    expect((await auditFor(output.translation.id)).at(-1)).toMatchObject({
      action: "output.set_status",
      before: { status: "generated" },
      after: { status: "excluded", reasonCode: "translation_problem" },
    });

    // Back to generated: the flag is resolved, the text is still the same.
    await setOutputStatus(t.adminCtx, { entityType: "translation", entityId: output.translation.id, status: "generated" });
    const [restored] = await t.ctx.db.select().from(translations).where(eq(translations.id, output.translation.id));
    expect(restored).toEqual(before);
  });

  it("marks a synthesis as reviewed", async () => {
    const synthesis = processed.batches[0]?.outputs[0]?.synthesis.synthesis;
    if (!synthesis) throw new Error("missing synthesis");
    await setOutputStatus(t.adminCtx, { entityType: "synthesis", entityId: synthesis.id, status: "reviewed" });
    const [row] = await t.ctx.db.select().from(syntheses).where(eq(syntheses.id, synthesis.id));
    expect(row).toEqual({ ...synthesis, status: "reviewed" });
  });

  it("offers no way to change the text, and the database refuses a direct change", async () => {
    const output = processed.batches[0]?.outputs[2];
    if (!output) throw new Error("missing output");
    await expect(
      setOutputStatus(t.adminCtx, {
        entityType: "translation",
        entityId: output.translation.id,
        status: "deleted" as never,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The input type has no text field, and an extra field is ignored.
    await setOutputStatus(t.adminCtx, {
      entityType: "translation",
      entityId: output.translation.id,
      status: "reviewed",
      ...({ translatedText: "changed" } as object),
    });
    const [row] = await t.ctx.db.select().from(translations).where(eq(translations.id, output.translation.id));
    expect(row?.translatedText).toBe(output.translation.translatedText);
    await expect(
      t.ctx.db.update(translations).set({ translatedText: "changed" }).where(eq(translations.id, output.translation.id)),
    ).rejects.toThrow();
    await expect(setOutputStatus(t.adminCtx, { entityType: "synthesis", entityId: MISSING, status: "excluded" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("audit history", () => {
  it("returns the audit rows of a session and of the records below it", async () => {
    const history = await getSessionAuditHistory(t.adminCtx, collected.session.id);
    const actions = history.items.map((item) => item.action);
    expect(actions).toContain("session.flag");
    expect(actions).toContain("utterance.exclude");
    expect(actions).toContain("note.create");
    expect(actions).toContain("output.set_status");
    // Nothing of the other session.
    expect(actions).not.toContain("session.exclude");
    expect(history.total).toBe(history.items.length);
    // Newest first.
    const times = history.items.map((item) => item.createdAt);
    expect([...times].sort().reverse()).toEqual(times);

    const paged = await getSessionAuditHistory(t.adminCtx, collected.session.id, { page: 2, pageSize: 2 });
    expect(paged.items).toHaveLength(2);
    expect(paged.total).toBe(history.total);
    await expect(getSessionAuditHistory(t.adminCtx, MISSING)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("filters the general audit view by entity and action", async () => {
    const bySession = await getAuditHistory(t.adminCtx, { entityType: "session", entityId: other.session.id });
    expect(bySession.items.map((item) => item.action)).toEqual(["session.include", "session.exclude"]);
    const byAction = await getAuditHistory(t.adminCtx, { action: "note.create" });
    expect(byAction.total).toBe(4);
    const all = await getAuditHistory(t.adminCtx, { pagination: { pageSize: 3 } });
    expect(all.items).toHaveLength(3);
    expect(all.total).toBeGreaterThan(10);
  });
});
