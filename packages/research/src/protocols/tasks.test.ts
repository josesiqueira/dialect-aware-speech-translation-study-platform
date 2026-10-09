import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAuditLog } from "@dialect/db";
import { insertStudy } from "@dialect/db/testing-builders";
import type { ServiceContext } from "../context";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  addFollowup,
  addTask,
  cloneTask,
  createProtocolDraft,
  deleteFollowup,
  deleteTask,
  getProtocolVersion,
  moveFollowup,
  moveTask,
  setTaskEnabled,
  updateFollowup,
  updateProtocolDraft,
  updateTask,
  type ProtocolDetail,
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

const layout = (detail: ProtocolDetail) =>
  detail.tasks.map((task) => `${task.orderIndex}:${task.blockKey}:${task.taskKey}`);

function expectDense(detail: ProtocolDetail) {
  expect(detail.tasks.map((task) => task.orderIndex)).toEqual(detail.tasks.map((_, index) => index));
  // The order mode of a task always follows its block.
  for (const task of detail.tasks) {
    const block = detail.protocol.orderConfigJson.blocks.find((candidate) => candidate.key === task.blockKey);
    expect(task.orderMode).toBe(block?.orderMode);
  }
}

// A draft with blocks a (shuffle), b (fixed), c (fixed) and tasks a1 a2 | b1 | (c empty).
async function draftWithTasks() {
  const study = await insertStudy(ctx.db);
  const draft = await createProtocolDraft(ctx, { studyId: study.id, name: "Draft" });
  const id = draft.protocol.id;
  await updateProtocolDraft(ctx, id, {
    orderConfig: {
      blocks: [
        { key: "a", title: "Block A", orderMode: "shuffle_within_block" },
        { key: "b", orderMode: "fixed" },
        { key: "c", orderMode: "fixed" },
      ],
    },
  });
  await addTask(ctx, id, { taskKey: "a1", taskType: "controlled", blockKey: "a", title: "A1", participantPrompt: "Prompt A1" });
  await addTask(ctx, id, { taskKey: "b1", taskType: "semi_structured", blockKey: "b", title: "B1", participantPrompt: "Prompt B1" });
  const detail = await addTask(ctx, id, {
    taskKey: "a2",
    taskType: "controlled",
    blockKey: "a",
    title: "A2",
    participantPrompt: "Prompt A2",
  });
  return { id, detail };
}

const taskId = (detail: ProtocolDetail, key: string) => detail.tasks.find((task) => task.taskKey === key)!.id;

describe("addTask", () => {
  it("appends to the end of its block, keeps the order dense and takes the block's order mode", async () => {
    const { detail } = await draftWithTasks();
    expect(layout(detail)).toEqual(["0:a:a1", "1:a:a2", "2:b:b1"]);
    expectDense(detail);
    expect(detail.tasks[0]?.orderMode).toBe("shuffle_within_block");
    expect(detail.tasks[2]?.orderMode).toBe("fixed");
  });

  it("derives a unique task key and stores the configuration fields", async () => {
    const { id } = await draftWithTasks();
    const first = await addTask(ctx, id, {
      taskType: "free_speech",
      blockKey: "c",
      internalName: "Free speech: Main",
      title: "Speak freely",
      participantPrompt: "Speak about anything.",
      suggestedDurationSeconds: 60,
      maxDurationSeconds: 120,
      researcherNotes: "Exploratory.",
      topicSuggestions: ["Your weekend", "A place you like"],
      followupMode: "optional",
    });
    const added = first.tasks.find((task) => task.blockKey === "c")!;
    expect(added.taskKey).toBe("free_speech_main");
    expect(added.privacyReminder).toBe(true); // default for free speech
    expect(added.enabled).toBe(true);
    expect(added.configJson).toEqual({
      topicSuggestions: ["Your weekend", "A place you like"],
      followupMode: "optional",
    });
    expect(added.researcherNotes).toBe("Exploratory.");

    const second = await addTask(ctx, id, { taskType: "free_speech", blockKey: "c", internalName: "Free speech: Main" });
    expect(second.tasks.filter((task) => task.blockKey === "c").map((task) => task.taskKey)).toEqual([
      "free_speech_main",
      "free_speech_main_2",
    ]);
    expectDense(second);

    await expect(
      addTask(ctx, id, { taskKey: "a1", taskType: "controlled", blockKey: "a" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      addTask(ctx, id, { taskType: "controlled", blockKey: "missing" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { blockKey: "missing" } });
    await expect(
      addTask(ctx, id, { taskType: "controlled", blockKey: "a", minDurationSeconds: 30, maxDurationSeconds: 10 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("updateTask and setTaskEnabled", () => {
  it("changes fields, never the task key, and writes an audit row with before and after", async () => {
    const { id, detail } = await draftWithTasks();
    const a1 = taskId(detail, "a1");
    const updated = await updateTask(ctx, a1, {
      participantPrompt: "A new prompt",
      contextText: "Some context",
      minDurationSeconds: 5,
      maxDurationSeconds: 60,
      randomizationEligible: false,
    });
    const task = updated.tasks.find((candidate) => candidate.id === a1)!;
    expect(task.taskKey).toBe("a1");
    expect(task.participantPrompt).toBe("A new prompt");
    expect(task.configJson).toEqual({ randomizationEligible: false });

    const audit = await ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, id));
    const last = audit.filter((row) => row.action === "protocol.update_draft").at(-1);
    expect(audit.every((row) => row.actorLabel === "admin")).toBe(true);
    expect(JSON.stringify(last?.beforeJson)).toContain("Prompt A1");
    expect(JSON.stringify(last?.afterJson)).toContain("A new prompt");

    const disabled = await setTaskEnabled(ctx, a1, false);
    expect(disabled.tasks.find((candidate) => candidate.id === a1)?.enabled).toBe(false);
    expectDense(disabled);

    await expect(updateTask(ctx, a1, { minDurationSeconds: 90 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(updateTask(ctx, a1, { blockKey: "missing" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(updateTask(ctx, "00000000-0000-4000-8000-000000000000", { title: "X" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // A task id that belongs to another protocol version is not found.
    await expect(
      updateTask(ctx, a1, { title: "X" }, { protocolVersionId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("moves a task to the end of another block when its block changes", async () => {
    const { detail } = await draftWithTasks();
    const moved = await updateTask(ctx, taskId(detail, "a1"), { blockKey: "b" });
    expect(layout(moved)).toEqual(["0:a:a2", "1:b:b1", "2:b:a1"]);
    expectDense(moved);
  });
});

describe("moveTask", () => {
  it("moves up and down inside a block and across blocks, and keeps the order dense", async () => {
    const { detail } = await draftWithTasks();
    const a1 = taskId(detail, "a1");
    const a2 = taskId(detail, "a2");
    const b1 = taskId(detail, "b1");

    // At the very top: nothing changes.
    let current = await moveTask(ctx, a1, "up");
    expect(layout(current)).toEqual(["0:a:a1", "1:a:a2", "2:b:b1"]);

    // Swap inside the block.
    current = await moveTask(ctx, a1, "down");
    expect(layout(current)).toEqual(["0:a:a2", "1:a:a1", "2:b:b1"]);
    expectDense(current);

    // At the bottom edge of block a: it becomes the first task of block b.
    current = await moveTask(ctx, a1, "down");
    expect(layout(current)).toEqual(["0:a:a2", "1:b:a1", "2:b:b1"]);
    expectDense(current);

    current = await moveTask(ctx, a1, "down");
    expect(layout(current)).toEqual(["0:a:a2", "1:b:b1", "2:b:a1"]);

    // Into the empty block c, then nothing below it.
    current = await moveTask(ctx, a1, "down");
    expect(layout(current)).toEqual(["0:a:a2", "1:b:b1", "2:c:a1"]);
    current = await moveTask(ctx, a1, "down");
    expect(layout(current)).toEqual(["0:a:a2", "1:b:b1", "2:c:a1"]);
    expectDense(current);

    // Back up: to the end of block b, then above b1, then to the end of block a.
    current = await moveTask(ctx, a1, "up");
    expect(layout(current)).toEqual(["0:a:a2", "1:b:b1", "2:b:a1"]);
    current = await moveTask(ctx, a1, "up");
    expect(layout(current)).toEqual(["0:a:a2", "1:b:a1", "2:b:b1"]);
    current = await moveTask(ctx, a1, "up");
    expect(layout(current)).toEqual(["0:a:a2", "1:a:a1", "2:b:b1"]);
    current = await moveTask(ctx, b1, "up");
    expect(layout(current)).toEqual(["0:a:a2", "1:a:a1", "2:a:b1"]);
    expectDense(current);
    current = await moveTask(ctx, a2, "down");
    expect(layout(current)).toEqual(["0:a:a1", "1:a:a2", "2:a:b1"]);
    expectDense(current);
  });
});

describe("cloneTask and deleteTask", () => {
  it("places the copy after the original with a new key and its follow-ups", async () => {
    const { detail } = await draftWithTasks();
    const a1 = taskId(detail, "a1");
    await addFollowup(ctx, a1, { promptText: "First follow-up" });
    await addFollowup(ctx, a1, { promptText: "Second follow-up", isRequired: false });
    const cloned = await cloneTask(ctx, a1);
    expect(layout(cloned)).toEqual(["0:a:a1", "1:a:a1_copy", "2:a:a2", "3:b:b1"]);
    expectDense(cloned);
    const copy = cloned.tasks[1]!;
    expect(copy.participantPrompt).toBe("Prompt A1");
    expect(copy.followups.map((followup) => [followup.followupKey, followup.promptText, followup.isRequired])).toEqual([
      ["followup_1", "First follow-up", true],
      ["followup_2", "Second follow-up", false],
    ]);

    const again = await cloneTask(ctx, a1);
    expect(again.tasks.map((task) => task.taskKey)).toEqual(["a1", "a1_copy_2", "a1_copy", "a2", "b1"]);

    const deleted = await deleteTask(ctx, a1);
    expect(deleted.tasks.map((task) => task.taskKey)).toEqual(["a1_copy_2", "a1_copy", "a2", "b1"]);
    expectDense(deleted);
    await expect(deleteTask(ctx, a1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("follow-ups", () => {
  it("adds, edits, reorders and deletes predefined follow-ups with dense order", async () => {
    const { id, detail } = await draftWithTasks();
    const b1 = taskId(detail, "b1");
    await addFollowup(ctx, b1, { promptText: "One" });
    await addFollowup(ctx, b1, { promptText: "Two" });
    let current = await addFollowup(ctx, b1, { promptText: "Three", followupKey: "third" });
    const followups = () => current.tasks.find((task) => task.id === b1)!.followups;
    expect(followups().map((followup) => `${followup.orderIndex}:${followup.followupKey}`)).toEqual([
      "0:followup_1",
      "1:followup_2",
      "2:third",
    ]);
    await expect(addFollowup(ctx, b1, { promptText: "Again", followupKey: "third" })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const third = followups()[2]!;
    current = await moveFollowup(ctx, third.id, "up");
    current = await moveFollowup(ctx, third.id, "up");
    current = await moveFollowup(ctx, third.id, "up"); // already first: no change
    expect(followups().map((followup) => `${followup.orderIndex}:${followup.followupKey}`)).toEqual([
      "0:third",
      "1:followup_1",
      "2:followup_2",
    ]);

    current = await updateFollowup(ctx, third.id, { promptText: "Three, edited", enabled: false });
    expect(followups()[0]).toMatchObject({ promptText: "Three, edited", enabled: false, followupKey: "third" });

    current = await deleteFollowup(ctx, followups()[1]!.id);
    expect(followups().map((followup) => `${followup.orderIndex}:${followup.followupKey}`)).toEqual([
      "0:third",
      "1:followup_2",
    ]);
    await expect(
      updateFollowup(ctx, third.id, { promptText: "X" }, { taskId: taskId(detail, "a1") }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Every change moved the draft's updated_at and wrote an audit row.
    const after = await getProtocolVersion(ctx, id);
    expect(after.protocol.updatedAt.getTime()).toBeGreaterThan(detail.protocol.updatedAt.getTime());
    const audit = await ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, id));
    expect(audit.filter((row) => JSON.stringify(row.afterJson ?? row.beforeJson).includes("followup")).length).toBe(7);
  });
});
