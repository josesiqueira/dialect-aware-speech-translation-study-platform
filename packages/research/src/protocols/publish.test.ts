import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAuditLog, protocolVersions, sessions, studies } from "@dialect/db";
import {
  insertConsentVersion,
  insertDraftProtocol,
  insertPublishedProtocol,
  insertQuestionnaire,
  insertSession,
  insertStudy,
} from "@dialect/db/testing-builders";
import type { ServiceContext } from "../context";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  addFollowup,
  addTask,
  cloneProtocolVersion,
  createProtocolDraft,
  deleteTask,
  diffProtocolVersions,
  getCurrentProtocol,
  getProtocolVersion,
  moveTask,
  publishProtocol,
  setTaskEnabled,
  updateFollowup,
  updateProtocolDraft,
  updateTask,
  validateProtocolForPublish,
} from "./index";

let t: TestServiceContext;
let ctx: ServiceContext;

beforeAll(async () => {
  t = await createTestServiceContext();
  ctx = t.adminCtx;
});

afterAll(async () => {
  await t.cleanup();
});

const codes = (problems: Array<{ code: string }>) => problems.map((problem) => problem.code);

async function studyWithPublishedProtocol() {
  const study = await insertStudy(ctx.db);
  const background = await insertQuestionnaire(ctx.db, { studyId: study.id, key: "background" });
  const post = await insertQuestionnaire(ctx.db, { studyId: study.id, key: "post_recording" });
  const published = await insertPublishedProtocol(ctx.db, {
    studyId: study.id,
    backgroundQuestionnaireVersionId: background.version.id,
    postQuestionnaireVersionId: post.version.id,
  });
  return { study, published, background, post };
}

describe("validateProtocolForPublish", () => {
  it("accepts a complete protocol without errors", async () => {
    const { published } = await studyWithPublishedProtocol();
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    const result = await validateProtocolForPublish(ctx, draft.protocol.id);
    expect(result).toMatchObject({ protocolVersionId: draft.protocol.id, canPublish: true, errors: [] });
    // The test protocol has a single task in its shuffled block.
    expect(codes(result.warnings)).toEqual(["shuffle_block_single_task"]);
  });

  it("reports every missing part of an empty draft", async () => {
    const study = await insertStudy(ctx.db);
    const draft = await createProtocolDraft(ctx, { studyId: study.id, name: "Empty" });
    const result = await validateProtocolForPublish(ctx, draft.protocol.id);
    expect(result.canPublish).toBe(false);
    expect(result.errors.filter((problem) => problem.code === "content_missing").map((problem) => problem.field)).toEqual([
      "welcomeContent",
      "informationContent",
      "instructionContent",
      "debriefContent",
    ]);
    expect(codes(result.errors)).toContain("consent_missing");
    expect(codes(result.errors)).toContain("no_enabled_task");
    expect(result.warnings.map((problem) => [problem.code, problem.field])).toEqual([
      ["questionnaire_not_selected", "backgroundQuestionnaireVersionId"],
      ["questionnaire_not_selected", "postQuestionnaireVersionId"],
    ]);
  });

  it("reports an unpublished consent version and unpublished questionnaires", async () => {
    const study = await insertStudy(ctx.db);
    const consentDraft = await insertConsentVersion(ctx.db, { studyId: study.id, publishedAt: null });
    const backgroundDraft = await insertQuestionnaire(ctx.db, { studyId: study.id, key: "background", status: "draft" });
    const wrongKey = await insertQuestionnaire(ctx.db, { studyId: study.id, key: "background" });
    // Built directly: the service refuses these selections when a draft is saved.
    const draft = await insertDraftProtocol(ctx.db, {
      studyId: study.id,
      consentVersionId: consentDraft.id,
      backgroundQuestionnaireVersionId: backgroundDraft.version.id,
      postQuestionnaireVersionId: wrongKey.version.id,
    });
    const result = await validateProtocolForPublish(ctx, draft.protocol.id);
    expect(codes(result.errors)).toEqual([
      "consent_not_published",
      "questionnaire_not_published",
      "questionnaire_wrong_key",
    ]);
    await expect(publishProtocol(ctx, draft.protocol.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("reports task problems: no enabled task, missing title and prompt, durations, unknown block", async () => {
    const { published } = await studyWithPublishedProtocol();
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    const id = draft.protocol.id;
    const [first, second] = draft.tasks;

    await setTaskEnabled(ctx, first!.id, false);
    await setTaskEnabled(ctx, second!.id, false);
    let result = await validateProtocolForPublish(ctx, id);
    expect(codes(result.errors)).toEqual(["no_enabled_task"]);

    await setTaskEnabled(ctx, first!.id, true);
    // A disabled task may be incomplete: only enabled tasks are checked.
    await updateTask(ctx, second!.id, { title: "", participantPrompt: "" });
    result = await validateProtocolForPublish(ctx, id);
    expect(result.errors).toEqual([]);

    await setTaskEnabled(ctx, second!.id, true);
    await updateTask(ctx, first!.id, {
      title: "  ",
      minDurationSeconds: 20,
      suggestedDurationSeconds: 10,
      maxDurationSeconds: 30,
    });
    await updateFollowup(ctx, second!.followups[0]!.id, { promptText: " " });
    result = await validateProtocolForPublish(ctx, id);
    expect(result.errors.map((problem) => [problem.code, problem.taskKey])).toEqual([
      ["task_title_missing", first!.taskKey],
      ["task_duration_inconsistent", first!.taskKey],
      ["task_title_missing", second!.taskKey],
      ["task_prompt_missing", second!.taskKey],
      ["followup_prompt_missing", second!.taskKey],
    ]);

    await updateTask(ctx, first!.id, { title: "Title", suggestedDurationSeconds: 40 });
    result = await validateProtocolForPublish(ctx, id);
    expect(result.errors.filter((problem) => problem.taskKey === first!.taskKey).map((problem) => problem.message)).toEqual([
      expect.stringContaining("suggested duration (40 s) is longer than the maximum duration (30 s)"),
    ]);
  });

  it("reports a task whose block is not in the order configuration", async () => {
    const study = await insertStudy(ctx.db);
    const consent = await insertConsentVersion(ctx.db, { studyId: study.id });
    const draft = await insertDraftProtocol(ctx.db, {
      studyId: study.id,
      consentVersionId: consent.id,
      orderConfigJson: { blocks: [{ key: "controlled", orderMode: "fixed" }] },
    });
    const result = await validateProtocolForPublish(ctx, draft.protocol.id);
    expect(result.errors.map((problem) => [problem.code, problem.taskKey])).toEqual([["task_block_missing", "semi_1"]]);
  });

  it("warns, without blocking, about free speech without the privacy reminder and priming wording", async () => {
    const { published } = await studyWithPublishedProtocol();
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    const id = draft.protocol.id;
    await updateProtocolDraft(ctx, id, {
      welcomeContent: "We believe AI flattens Finnish. Welcome to our Dialect study.",
      instructionContent: "Käytä murretta mahdollisimman vahvasti.",
      orderConfig: {
        blocks: [...draft.protocol.orderConfigJson.blocks, { key: "free", orderMode: "fixed" }],
      },
    });
    const withFree = await addTask(ctx, id, {
      taskType: "free_speech",
      blockKey: "free",
      title: "Free speech",
      participantPrompt: "Speak about anything.",
      privacyReminder: false,
    });
    expect(withFree.tasks.at(-1)?.privacyReminder).toBe(false);

    const result = await validateProtocolForPublish(ctx, id);
    expect(result.canPublish).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((problem) => [problem.code, problem.field ?? problem.taskKey, problem.specRef])).toEqual([
      ["free_speech_without_privacy_reminder", "free_speech", "7.3"],
      ["shuffle_block_single_task", "orderConfig", "8"],
      ["wording_mentions_dialect", "welcomeContent", "6.4"],
      ["wording_states_hypothesis", "welcomeContent", "6.1"],
      ["wording_mentions_dialect", "instructionContent", "6.4"],
      ["wording_asks_for_marked_speech", "instructionContent", "6.4"],
    ]);
    // Warnings do not block publishing, and they are recorded.
    const publishResult = await publishProtocol(ctx, id);
    expect(publishResult.warnings).toHaveLength(6);
  });
});

describe("publishProtocol", () => {
  it("publishes, makes the version current for new sessions and leaves existing sessions pinned", async () => {
    const { study, published } = await studyWithPublishedProtocol();
    const existingSession = await insertSession(ctx.db, {
      studyId: study.id,
      protocolVersionId: published.protocol.id,
    });
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    await updateTask(ctx, draft.tasks[0]!.id, { participantPrompt: "A changed prompt." });
    t.clock.set(new Date("2026-11-01T10:00:00.000Z"));

    const result = await publishProtocol(ctx, draft.protocol.id);
    expect(result.previousProtocolVersionId).toBe(published.protocol.id);
    expect(result.protocol.protocol).toMatchObject({
      status: "published",
      isCurrent: true,
      publishedAt: new Date("2026-11-01T10:00:00.000Z"),
    });
    expect(result.diffSummary).toMatchObject({ tasksChanged: 1, tasksAdded: 0, tasksRemoved: 0 });

    const [studyRow] = await ctx.db.select().from(studies).where(eq(studies.id, study.id));
    expect(studyRow?.currentProtocolVersionId).toBe(draft.protocol.id);
    expect((await getCurrentProtocol(ctx, study.id))?.protocol.id).toBe(draft.protocol.id);

    // The session that existed before still points at the old version, which
    // stays published and unchanged.
    const [sessionRow] = await ctx.db.select().from(sessions).where(eq(sessions.id, existingSession.id));
    expect(sessionRow?.protocolVersionId).toBe(published.protocol.id);
    const old = await getProtocolVersion(ctx, published.protocol.id);
    expect(old.protocol.status).toBe("published");
    expect(old.protocol.isCurrent).toBe(false);
    expect(old.tasks[0]?.participantPrompt).toBe(published.tasks[0]?.participantPrompt);

    const audit = await ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, draft.protocol.id));
    const publishRows = audit.filter((row) => row.action === "protocol.publish");
    expect(publishRows).toHaveLength(1);
    expect(publishRows[0]?.actorLabel).toBe("admin");
    expect(publishRows[0]?.beforeJson).toMatchObject({ status: "draft", currentProtocolVersionId: published.protocol.id });
    expect(publishRows[0]?.afterJson).toMatchObject({
      status: "published",
      currentProtocolVersionId: draft.protocol.id,
      diffSummary: { tasksChanged: 1 },
    });

    // The new version is now immutable, and publishing twice is refused.
    await expect(updateProtocolDraft(ctx, draft.protocol.id, { name: "X" })).rejects.toMatchObject({
      code: "IMMUTABLE_RECORD",
    });
    await expect(publishProtocol(ctx, draft.protocol.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("is atomic: a failed check changes nothing", async () => {
    const { study, published } = await studyWithPublishedProtocol();
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    await updateProtocolDraft(ctx, draft.protocol.id, { debriefContent: "" });
    const before = await getProtocolVersion(ctx, draft.protocol.id);

    await expect(publishProtocol(ctx, draft.protocol.id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { problems: [{ code: "content_missing", field: "debriefContent", severity: "error" }] },
    });

    expect(await getProtocolVersion(ctx, draft.protocol.id)).toEqual(before);
    const [row] = await ctx.db.select().from(protocolVersions).where(eq(protocolVersions.id, draft.protocol.id));
    expect(row).toMatchObject({ status: "draft", publishedAt: null });
    const [studyRow] = await ctx.db.select().from(studies).where(eq(studies.id, study.id));
    expect(studyRow?.currentProtocolVersionId).toBe(published.protocol.id);
    const audit = await ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, draft.protocol.id));
    expect(audit.filter((row) => row.action === "protocol.publish")).toHaveLength(0);
  });

  it("publishes a first protocol when the study has none", async () => {
    const study = await insertStudy(ctx.db);
    const consent = await insertConsentVersion(ctx.db, { studyId: study.id });
    const draft = await insertDraftProtocol(ctx.db, { studyId: study.id, consentVersionId: consent.id });
    const result = await publishProtocol(ctx, draft.protocol.id);
    expect(result.previousProtocolVersionId).toBeNull();
    expect(result.diffSummary.tasksAdded).toBe(2);
    expect(result.protocol.protocol.isCurrent).toBe(true);
  });
});

describe("diffProtocolVersions", () => {
  it("lists text changes, tasks added, removed, changed, reordered and switched off, and selection changes", async () => {
    const { study, published } = await studyWithPublishedProtocol();
    // Start from a version with three tasks so that one can be removed and two reordered.
    const base = await cloneProtocolVersion(ctx, published.protocol.id);
    await addTask(ctx, base.protocol.id, {
      taskKey: "semi_2",
      taskType: "semi_structured",
      blockKey: "semi_structured",
      title: "Second semi-structured task",
      participantPrompt: "Tell us about a polite disagreement.",
    });
    await addTask(ctx, base.protocol.id, {
      taskKey: "semi_3",
      taskType: "semi_structured",
      blockKey: "semi_structured",
      title: "Third",
      participantPrompt: "To be removed.",
    });
    await publishProtocol(ctx, base.protocol.id);

    const draft = await cloneProtocolVersion(ctx, base.protocol.id);
    const id = draft.protocol.id;
    const task = (key: string) => draft.tasks.find((candidate) => candidate.taskKey === key)!;
    const newConsent = await insertConsentVersion(ctx.db, { studyId: study.id, title: "Consent, second version" });

    await updateProtocolDraft(ctx, id, {
      welcomeContent: "Test welcome text, now longer.",
      consentVersionId: newConsent.id,
      postQuestionnaireVersionId: null,
    });
    await updateTask(ctx, task("controlled_1").id, {
      participantPrompt: "Test prompt for a changed controlled task.",
      maxDurationSeconds: 90,
    });
    await setTaskEnabled(ctx, task("semi_2").id, false);
    await moveTask(ctx, task("semi_2").id, "up");
    await deleteTask(ctx, task("semi_3").id);
    await updateFollowup(ctx, task("semi_1").followups[0]!.id, { promptText: "A changed follow-up prompt." });
    await addFollowup(ctx, task("semi_1").id, { promptText: "A new follow-up." });
    await addTask(ctx, id, {
      taskKey: "controlled_2",
      taskType: "controlled",
      blockKey: "controlled",
      title: "New controlled task",
      participantPrompt: "A new situation.",
    });

    const diff = await diffProtocolVersions(ctx, base.protocol.id, id);
    expect(diff.from).toMatchObject({ id: base.protocol.id, versionNumber: 2, status: "published" });
    expect(diff.to).toMatchObject({ id, versionNumber: 3, status: "draft" });
    expect(diff.hasChanges).toBe(true);

    expect(diff.contentChanges).toHaveLength(1);
    expect(diff.contentChanges[0]).toMatchObject({
      field: "welcomeContent",
      before: "Test welcome text.",
      after: "Test welcome text, now longer.",
    });
    expect(diff.contentChanges[0]?.parts.some((part) => part.added)).toBe(true);
    expect(diff.contentChanges[0]?.parts.map((part) => (part.removed ? "" : part.value)).join("")).toBe(
      "Test welcome text, now longer.",
    );

    expect(diff.consentChange).toMatchObject({
      before: { id: published.consent.id },
      after: { id: newConsent.id, name: "Consent, second version" },
    });
    expect(diff.questionnaireChanges).toHaveLength(1);
    expect(diff.questionnaireChanges[0]).toMatchObject({ slot: "post_recording", after: null });
    expect(diff.questionnaireChanges[0]?.before).not.toBeNull();

    expect(diff.tasksAdded.map((added) => added.taskKey)).toEqual(["controlled_2"]);
    expect(diff.tasksRemoved.map((removed) => removed.taskKey)).toEqual(["semi_3"]);
    expect(diff.tasksReordered.map((moved) => moved.taskKey).sort()).toEqual(["semi_1", "semi_2"]);
    expect(diff.ordering).toMatchObject({ changed: true, taskOrderChanged: true, blocksChanged: false });
    expect(diff.ordering.taskOrderBefore).toEqual(["controlled_1", "semi_1", "semi_2", "semi_3"]);
    expect(diff.ordering.taskOrderAfter).toEqual(["controlled_1", "controlled_2", "semi_2", "semi_1"]);

    const changed = Object.fromEntries(diff.tasksChanged.map((change) => [change.taskKey, change]));
    expect(Object.keys(changed).sort()).toEqual(["controlled_1", "semi_1", "semi_2"]);
    expect(changed.controlled_1?.promptChange).toMatchObject({
      before: "Test prompt for a controlled task.",
      after: "Test prompt for a changed controlled task.",
    });
    expect(changed.controlled_1?.valueChanges).toEqual([
      { field: "maxDurationSeconds", label: "Maximum duration (s)", before: null, after: 90 },
    ]);
    expect(changed.semi_2?.enabledChange).toEqual({ before: true, after: false });
    expect(changed.semi_2?.promptChange).toBeNull();
    expect(changed.semi_1?.followups.changed[0]?.text).toMatchObject({
      before: "Test follow-up prompt.",
      after: "A changed follow-up prompt.",
    });
    expect(changed.semi_1?.followups.added.map((followup) => followup.promptText)).toEqual(["A new follow-up."]);

    expect(diff.summary).toEqual({
      contentFieldsChanged: ["welcomeContent"],
      tasksAdded: 1,
      tasksRemoved: 1,
      tasksChanged: 3,
      tasksReordered: 2,
      tasksEnabledOrDisabled: 1,
      followupsChanged: 1,
      consentChanged: true,
      questionnairesChanged: true,
      orderingChanged: true,
    });
  });

  it("reports no changes for a fresh clone and everything as new without an earlier version", async () => {
    const { published } = await studyWithPublishedProtocol();
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    const same = await diffProtocolVersions(ctx, published.protocol.id, draft.protocol.id);
    expect(same.hasChanges).toBe(false);
    expect(same.tasksChanged).toEqual([]);

    const first = await diffProtocolVersions(ctx, null, draft.protocol.id);
    expect(first.from).toBeNull();
    expect(first.tasksAdded).toHaveLength(2);
    expect(first.contentChanges.map((change) => change.field)).toContain("welcomeContent");
  });
});
