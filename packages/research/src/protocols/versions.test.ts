import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAuditLog, protocolTaskFollowups, protocolTasks, protocolVersions, studies } from "@dialect/db";
import {
  insertConsentVersion,
  insertDraftProtocol,
  insertPublishedProtocol,
  insertQuestionnaire,
  insertSession,
  insertStudy,
  publishProtocol as publishWithBuilder,
} from "@dialect/db/testing-builders";
import type { ServiceContext } from "../context";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  addFollowup,
  addTask,
  cloneProtocolVersion,
  createProtocolDraft,
  deleteFollowup,
  deleteProtocolDraft,
  deleteTask,
  getCurrentProtocol,
  getProtocolVersion,
  listProtocolOptions,
  listProtocolVersions,
  moveTask,
  publishProtocol,
  retireProtocol,
  setTaskEnabled,
  updateFollowup,
  updateProtocolDraft,
  updateTask,
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

async function auditRows(entityId: string, action?: string) {
  const rows = await ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, entityId));
  return action ? rows.filter((row) => row.action === action) : rows;
}

// A study with one published, current protocol (two tasks, one follow-up).
async function studyWithPublishedProtocol() {
  const study = await insertStudy(ctx.db);
  const published = await insertPublishedProtocol(ctx.db, { studyId: study.id });
  return { study, published };
}

describe("createProtocolDraft", () => {
  it("creates an empty draft with the next version number and an audit row", async () => {
    const { study, published } = await studyWithPublishedProtocol();
    const draft = await createProtocolDraft(ctx, { studyId: study.id, name: "  Second protocol " });
    expect(draft.protocol.status).toBe("draft");
    expect(draft.protocol.versionNumber).toBe(published.protocol.versionNumber + 1);
    expect(draft.protocol.name).toBe("Second protocol");
    expect(draft.protocol.createdByLabel).toBe("admin");
    expect(draft.tasks).toEqual([]);
    expect(draft.protocol.orderConfigJson).toEqual({ blocks: [] });
    expect(draft.protocol.isCurrent).toBe(false);

    const audit = await auditRows(draft.protocol.id, "protocol.create");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorLabel).toBe("admin");
    expect(audit[0]?.afterJson).toMatchObject({ versionNumber: draft.protocol.versionNumber });
  });

  it("refuses a second draft and names the existing one", async () => {
    const { study } = await studyWithPublishedProtocol();
    const first = await createProtocolDraft(ctx, { studyId: study.id, name: "Draft A" });
    await expect(createProtocolDraft(ctx, { studyId: study.id, name: "Draft B" })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { draftProtocolVersionId: first.protocol.id },
    });
    await expect(createProtocolDraft(ctx, { studyId: study.id, name: "Draft B" })).rejects.toThrow(
      /Protocol v2 \("Draft A"\)/,
    );
    // Cloning also creates a draft, so it is refused for the same reason.
    const current = await getCurrentProtocol(ctx, study.id);
    await expect(cloneProtocolVersion(ctx, current!.protocol.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows only one of two simultaneous requests", async () => {
    const study = await insertStudy(ctx.db);
    const results = await Promise.allSettled([
      createProtocolDraft(ctx, { studyId: study.id, name: "A" }),
      createProtocolDraft(ctx, { studyId: study.id, name: "B" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const versions = await listProtocolVersions(ctx, study.id);
    expect(versions).toHaveLength(1);
  });
});

describe("cloneProtocolVersion", () => {
  it("copies texts, order config, selections, tasks and follow-ups, and keeps the task keys", async () => {
    const study = await insertStudy(ctx.db);
    const background = await insertQuestionnaire(ctx.db, { studyId: study.id, key: "background" });
    const post = await insertQuestionnaire(ctx.db, { studyId: study.id, key: "post_recording" });
    const published = await insertPublishedProtocol(ctx.db, {
      studyId: study.id,
      description: "First version",
      backgroundQuestionnaireVersionId: background.version.id,
      postQuestionnaireVersionId: post.version.id,
    });
    const source = await getProtocolVersion(ctx, published.protocol.id);

    const clone = await cloneProtocolVersion(ctx, published.protocol.id);
    expect(clone.protocol.id).not.toBe(source.protocol.id);
    expect(clone.protocol.status).toBe("draft");
    expect(clone.protocol.publishedAt).toBeNull();
    expect(clone.protocol.versionNumber).toBe(source.protocol.versionNumber + 1);
    expect(clone.protocol.clonedFromProtocolVersionId).toBe(source.protocol.id);
    for (const field of [
      "name",
      "description",
      "welcomeContent",
      "informationContent",
      "instructionContent",
      "debriefContent",
      "consentVersionId",
      "backgroundQuestionnaireVersionId",
      "postQuestionnaireVersionId",
      "orderConfigJson",
    ] as const) {
      expect(clone.protocol[field]).toEqual(source.protocol[field]);
    }
    expect(clone.consentVersion?.id).toBe(published.consent.id);
    expect(clone.backgroundQuestionnaire?.items).toHaveLength(background.items.length);

    expect(clone.tasks.map((task) => task.taskKey)).toEqual(source.tasks.map((task) => task.taskKey));
    for (const [index, task] of clone.tasks.entries()) {
      const original = source.tasks[index]!;
      expect(task.id).not.toBe(original.id);
      expect(task.protocolVersionId).toBe(clone.protocol.id);
      const { id: _a, protocolVersionId: _b, createdAt: _c, followups: cloneFollowups, ...copied } = task;
      const { id: _d, protocolVersionId: _e, createdAt: _f, followups: sourceFollowups, ...expected } = original;
      expect(copied).toEqual(expected);
      expect(cloneFollowups.map(({ followupKey, promptText, orderIndex, isRequired, enabled }) => ({
        followupKey,
        promptText,
        orderIndex,
        isRequired,
        enabled,
      }))).toEqual(
        sourceFollowups.map(({ followupKey, promptText, orderIndex, isRequired, enabled }) => ({
          followupKey,
          promptText,
          orderIndex,
          isRequired,
          enabled,
        })),
      );
    }
    expect(clone.tasks.flatMap((task) => task.followups)).toHaveLength(1);

    // The source is untouched.
    expect(await getProtocolVersion(ctx, published.protocol.id)).toEqual(source);
    const audit = await auditRows(clone.protocol.id, "protocol.clone");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.beforeJson).toMatchObject({ clonedFromProtocolVersionId: source.protocol.id });
  });
});

describe("a published protocol cannot be edited", () => {
  it("refuses every change to the version, its tasks and its follow-ups with IMMUTABLE_RECORD", async () => {
    const { published } = await studyWithPublishedProtocol();
    const id = published.protocol.id;
    const before = await getProtocolVersion(ctx, id);
    const task = before.tasks[0]!;
    const taskWithFollowup = before.tasks.find((candidate) => candidate.followups.length > 0)!;
    const followup = taskWithFollowup.followups[0]!;
    const immutable = { code: "IMMUTABLE_RECORD" };

    await expect(updateProtocolDraft(ctx, id, { welcomeContent: "Changed" })).rejects.toMatchObject(immutable);
    await expect(updateProtocolDraft(ctx, id, { name: "Changed" })).rejects.toThrow(/Clone it to a new draft/);
    await expect(
      addTask(ctx, id, { taskType: "controlled", blockKey: "controlled", title: "New" }),
    ).rejects.toMatchObject(immutable);
    await expect(updateTask(ctx, task.id, { participantPrompt: "Changed" })).rejects.toMatchObject(immutable);
    await expect(setTaskEnabled(ctx, task.id, false)).rejects.toMatchObject(immutable);
    await expect(moveTask(ctx, task.id, "down")).rejects.toMatchObject(immutable);
    await expect(deleteTask(ctx, task.id)).rejects.toMatchObject(immutable);
    await expect(addFollowup(ctx, task.id, { promptText: "New follow-up" })).rejects.toMatchObject(immutable);
    await expect(updateFollowup(ctx, followup.id, { promptText: "Changed" })).rejects.toMatchObject(immutable);
    await expect(deleteFollowup(ctx, followup.id)).rejects.toMatchObject(immutable);
    await expect(deleteProtocolDraft(ctx, id)).rejects.toMatchObject(immutable);

    expect(await getProtocolVersion(ctx, id)).toEqual(before);
    expect(await auditRows(id, "protocol.update_draft")).toHaveLength(0);
  });

  it("refuses changes to a retired version as well", async () => {
    const { study, published } = await studyWithPublishedProtocol();
    const next = await insertPublishedProtocol(ctx.db, { studyId: study.id, consentVersionId: published.consent.id });
    expect(next.protocol.id).not.toBe(published.protocol.id);
    await retireProtocol(ctx, published.protocol.id);
    await expect(updateProtocolDraft(ctx, published.protocol.id, { name: "X" })).rejects.toMatchObject({
      code: "IMMUTABLE_RECORD",
    });
  });
});

describe("updateProtocolDraft", () => {
  it("saves the changed fields and writes one audit row with before and after", async () => {
    const { study, published } = await studyWithPublishedProtocol();
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    const updated = await updateProtocolDraft(ctx, draft.protocol.id, {
      welcomeContent: "A new welcome text.",
      name: draft.protocol.name, // unchanged, must not appear in the audit row
      expectedUpdatedAt: draft.protocol.updatedAt,
    });
    expect(updated.protocol.welcomeContent).toBe("A new welcome text.");
    expect(updated.protocol.updatedAt.getTime()).toBeGreaterThan(draft.protocol.updatedAt.getTime());

    const audit = await auditRows(draft.protocol.id, "protocol.update_draft");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.beforeJson).toEqual({ welcomeContent: draft.protocol.welcomeContent });
    expect(audit[0]?.afterJson).toEqual({ welcomeContent: "A new welcome text." });

    // A save without any change writes nothing.
    const same = await updateProtocolDraft(ctx, draft.protocol.id, { welcomeContent: "A new welcome text." });
    expect(same.protocol.updatedAt).toEqual(updated.protocol.updatedAt);
    expect(await auditRows(draft.protocol.id, "protocol.update_draft")).toHaveLength(1);

    // The published version did not change.
    const current = await getCurrentProtocol(ctx, study.id);
    expect(current?.protocol.id).toBe(published.protocol.id);
    expect(current?.protocol.welcomeContent).toBe(published.protocol.welcomeContent);
  });

  it("refuses a save made with a stale updated_at (optimistic concurrency)", async () => {
    const { published } = await studyWithPublishedProtocol();
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    const loadedByBoth = draft.protocol.updatedAt;

    const first = await updateProtocolDraft(ctx, draft.protocol.id, {
      welcomeContent: "Editor one",
      expectedUpdatedAt: loadedByBoth,
    });
    await expect(
      updateProtocolDraft(ctx, draft.protocol.id, { debriefContent: "Editor two", expectedUpdatedAt: loadedByBoth }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { currentUpdatedAt: first.protocol.updatedAt.toISOString() },
    });
    // The ISO string form that the API receives works the same way.
    await expect(
      updateProtocolDraft(ctx, draft.protocol.id, {
        debriefContent: "Editor two",
        expectedUpdatedAt: loadedByBoth.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await getProtocolVersion(ctx, draft.protocol.id);
    expect(after.protocol.welcomeContent).toBe("Editor one");
    expect(after.protocol.debriefContent).toBe(draft.protocol.debriefContent);

    // A task edit moves updated_at forward too, so it also invalidates an open editor.
    await setTaskEnabled(ctx, after.tasks[0]!.id, false, { expectedUpdatedAt: after.protocol.updatedAt });
    await expect(
      updateProtocolDraft(ctx, draft.protocol.id, { name: "Late", expectedUpdatedAt: after.protocol.updatedAt }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      updateTask(ctx, after.tasks[0]!.id, { title: "Late" }, { expectedUpdatedAt: after.protocol.updatedAt }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("accepts only published consent and questionnaire versions with the right key", async () => {
    const study = await insertStudy(ctx.db);
    const otherStudy = await insertStudy(ctx.db);
    const draft = await createProtocolDraft(ctx, { studyId: study.id, name: "Draft" });
    const id = draft.protocol.id;
    const consentDraft = await insertConsentVersion(ctx.db, { studyId: study.id, publishedAt: null });
    const consent = await insertConsentVersion(ctx.db, { studyId: study.id });
    const foreignConsent = await insertConsentVersion(ctx.db, { studyId: otherStudy.id });
    const background = await insertQuestionnaire(ctx.db, { studyId: study.id, key: "background" });
    const backgroundDraft = await insertQuestionnaire(ctx.db, { studyId: study.id, key: "background", status: "draft" });
    const post = await insertQuestionnaire(ctx.db, { studyId: study.id, key: "post_recording" });
    const invalid = { code: "VALIDATION_ERROR" };

    await expect(updateProtocolDraft(ctx, id, { consentVersionId: consentDraft.id })).rejects.toMatchObject(invalid);
    await expect(updateProtocolDraft(ctx, id, { consentVersionId: foreignConsent.id })).rejects.toMatchObject(invalid);
    await expect(
      updateProtocolDraft(ctx, id, { backgroundQuestionnaireVersionId: backgroundDraft.version.id }),
    ).rejects.toMatchObject(invalid);
    await expect(
      updateProtocolDraft(ctx, id, { backgroundQuestionnaireVersionId: post.version.id }),
    ).rejects.toMatchObject(invalid);

    const updated = await updateProtocolDraft(ctx, id, {
      consentVersionId: consent.id,
      backgroundQuestionnaireVersionId: background.version.id,
      postQuestionnaireVersionId: post.version.id,
    });
    expect(updated.consentVersion?.id).toBe(consent.id);
    expect(updated.backgroundQuestionnaire?.id).toBe(background.version.id);
    expect(updated.postQuestionnaire?.id).toBe(post.version.id);

    const cleared = await updateProtocolDraft(ctx, id, { postQuestionnaireVersionId: null });
    expect(cleared.postQuestionnaire).toBeNull();

    const options = await listProtocolOptions(ctx, study.id);
    expect(options.consentVersions.map((row) => row.id)).toEqual([consent.id]);
    expect(options.backgroundQuestionnaires.map((row) => row.id)).toEqual([background.version.id]);
    expect(options.postQuestionnaires.map((row) => row.id)).toEqual([post.version.id]);
  });

  it("keeps tasks consistent when the blocks are reordered, changed or removed", async () => {
    const { published } = await studyWithPublishedProtocol();
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    const id = draft.protocol.id;
    expect(draft.tasks.map((task) => task.blockKey)).toEqual(["controlled", "semi_structured"]);

    // Swap the blocks and change the order mode of one of them.
    const swapped = await updateProtocolDraft(ctx, id, {
      orderConfig: {
        blocks: [
          { key: "semi_structured", title: "Semi", orderMode: "shuffle_within_block" },
          { key: "controlled", orderMode: "fixed" },
        ],
      },
    });
    expect(swapped.tasks.map((task) => task.taskKey)).toEqual(["semi_1", "controlled_1"]);
    expect(swapped.tasks.map((task) => task.orderIndex)).toEqual([0, 1]);
    expect(swapped.tasks.map((task) => task.orderMode)).toEqual(["shuffle_within_block", "fixed"]);

    // A block that still has tasks cannot be removed.
    await expect(
      updateProtocolDraft(ctx, id, { orderConfig: { blocks: [{ key: "controlled", orderMode: "fixed" }] } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { blockKeys: ["semi_structured"] } });

    // An empty block can be added and removed.
    const withExtra = await updateProtocolDraft(ctx, id, {
      orderConfig: { blocks: [...swapped.protocol.orderConfigJson.blocks, { key: "free", orderMode: "fixed" }] },
    });
    expect(withExtra.protocol.orderConfigJson.blocks).toHaveLength(3);
    const withoutExtra = await updateProtocolDraft(ctx, id, {
      orderConfig: { blocks: swapped.protocol.orderConfigJson.blocks },
    });
    expect(withoutExtra.protocol.orderConfigJson.blocks).toHaveLength(2);
  });
});

describe("deleteProtocolDraft", () => {
  it("deletes the draft with its tasks and follow-ups and writes an audit row", async () => {
    const { study, published } = await studyWithPublishedProtocol();
    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    const taskIds = draft.tasks.map((task) => task.id);
    const result = await deleteProtocolDraft(ctx, draft.protocol.id);
    expect(result).toEqual({ deleted: true, id: draft.protocol.id, versionNumber: draft.protocol.versionNumber });

    await expect(getProtocolVersion(ctx, draft.protocol.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const taskId of taskIds) {
      expect(await ctx.db.select().from(protocolTasks).where(eq(protocolTasks.id, taskId))).toHaveLength(0);
      expect(
        await ctx.db.select().from(protocolTaskFollowups).where(eq(protocolTaskFollowups.protocolTaskId, taskId)),
      ).toHaveLength(0);
    }
    const audit = await auditRows(draft.protocol.id, "protocol.delete_draft");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.beforeJson).toMatchObject({ versionNumber: draft.protocol.versionNumber, taskCount: 2 });

    // The published version and its tasks are still there, and a new draft can be made.
    const versions = await listProtocolVersions(ctx, study.id);
    expect(versions.map((version) => version.id)).toEqual([published.protocol.id]);
    expect(versions[0]).toMatchObject({ isCurrent: true, taskCount: 2, enabledTaskCount: 2, sessionCount: 0 });
    await expect(cloneProtocolVersion(ctx, published.protocol.id)).resolves.toBeTruthy();
  });

  it("refuses to delete a draft that a published version was cloned from, with a clear message", async () => {
    const study = await insertStudy(ctx.db);
    const consent = await insertConsentVersion(ctx.db, { studyId: study.id });
    // This state cannot be reached through the services (one draft at a time).
    // It is built directly to check the message.
    const base = await insertDraftProtocol(ctx.db, { studyId: study.id, consentVersionId: consent.id });
    const derived = await insertDraftProtocol(ctx.db, {
      studyId: study.id,
      consentVersionId: consent.id,
      clonedFromProtocolVersionId: base.protocol.id,
    });
    await publishWithBuilder(ctx.db, derived.protocol.id);

    await expect(deleteProtocolDraft(ctx, base.protocol.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(deleteProtocolDraft(ctx, base.protocol.id)).rejects.toThrow(/cloned from this draft/);
    expect(
      await ctx.db.select().from(protocolVersions).where(eq(protocolVersions.id, base.protocol.id)),
    ).toHaveLength(1);
  });
});

describe("retireProtocol", () => {
  it("retires a published version that is not current and keeps its sessions pinned", async () => {
    const { study, published } = await studyWithPublishedProtocol();
    const session = await insertSession(ctx.db, { studyId: study.id, protocolVersionId: published.protocol.id });

    await expect(retireProtocol(ctx, published.protocol.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(retireProtocol(ctx, published.protocol.id)).rejects.toThrow(/current protocol/);

    const draft = await cloneProtocolVersion(ctx, published.protocol.id);
    await expect(retireProtocol(ctx, draft.protocol.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await publishProtocol(ctx, draft.protocol.id);

    const retired = await retireProtocol(ctx, published.protocol.id);
    expect(retired.protocol.status).toBe("retired");
    expect(retired.protocol.retiredAt).toEqual(t.clock.now());
    await expect(retireProtocol(ctx, published.protocol.id)).rejects.toMatchObject({ code: "INVALID_STATE" });

    const versions = await listProtocolVersions(ctx, study.id);
    expect(versions.map((version) => [version.versionNumber, version.status, version.isCurrent])).toEqual([
      [2, "published", true],
      [1, "retired", false],
    ]);
    expect(versions[1]?.sessionCount).toBe(1);
    expect(session.protocolVersionId).toBe(published.protocol.id);
    const audit = await auditRows(published.protocol.id, "protocol.retire");
    expect(audit).toHaveLength(1);

    const [studyRow] = await ctx.db
      .select()
      .from(studies)
      .where(and(eq(studies.id, study.id)));
    expect(studyRow?.currentProtocolVersionId).toBe(draft.protocol.id);
  });
});
