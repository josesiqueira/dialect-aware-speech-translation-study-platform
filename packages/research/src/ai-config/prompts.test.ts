import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAuditLog, aiPromptVersions, modelConfigs, modelRuns } from "@dialect/db";
import { insertActiveAiConfigs, insertModelRun, insertStudy } from "@dialect/db/testing-builders";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import type { ServiceContext } from "../context";
import {
  activatePromptVersion,
  clonePromptVersion,
  createPromptDraft,
  deletePromptDraft,
  diffPromptVersions,
  getActivePrompt,
  getPromptVersion,
  listPromptVersions,
  retirePromptVersion,
  updatePromptDraft,
} from "./prompts";
import { resolveStudy } from "./shared";

let t: TestServiceContext;
let ctx: ServiceContext;

beforeAll(async () => {
  t = await createTestServiceContext();
  ctx = t.adminCtx;
});

afterAll(async () => {
  await t.cleanup();
});

async function newStudy(): Promise<string> {
  return (await insertStudy(ctx.db)).id;
}

async function auditRows(entityId: string) {
  return ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, entityId)).orderBy(adminAuditLog.createdAt);
}

const draftInput = (studyId: string, overrides: Record<string, unknown> = {}) => ({
  studyId,
  key: "translation_default",
  stage: "translation" as const,
  conditionKey: "default",
  name: "Default translation",
  promptText: "Translate from {{source_language}} to {{target_language}}.",
  ...overrides,
});

describe("prompt drafts", () => {
  it("creates the first draft as version 1 and writes an audit row", async () => {
    const studyId = await newStudy();
    const draft = await createPromptDraft(ctx, draftInput(studyId, { notes: "first" }));
    expect(draft).toMatchObject({
      key: "translation_default",
      stage: "translation",
      conditionKey: "default",
      versionNumber: 1,
      status: "draft",
      notes: "first",
      createdByLabel: "admin",
      activatedAt: null,
      retiredAt: null,
    });
    expect(draft.createdAt.toISOString()).toBe(t.clock.now().toISOString());
    const audit = await auditRows(draft.id);
    expect(audit.map((row) => row.action)).toEqual(["ai_prompt.create"]);
    expect(audit[0]).toMatchObject({ entityType: "ai_prompt_version", actorLabel: "admin" });
  });

  it("allows only one draft per key and names the existing draft", async () => {
    const studyId = await newStudy();
    const draft = await createPromptDraft(ctx, draftInput(studyId));
    await expect(createPromptDraft(ctx, draftInput(studyId))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("translation_default v1"),
      details: { existingDraftId: draft.id },
    });
    // Another key is not affected.
    const other = await createPromptDraft(ctx, draftInput(studyId, { key: "translation_preserve" }));
    expect(other.versionNumber).toBe(1);
    // Two requests at the same moment: exactly one draft is created.
    const key = "translation_parallel";
    const results = await Promise.allSettled([
      createPromptDraft(ctx, draftInput(studyId, { key })),
      createPromptDraft(ctx, draftInput(studyId, { key })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await listPromptVersions(ctx, { studyId, key })).toHaveLength(1);
  });

  it("updates a draft and records before and after in the audit log", async () => {
    const studyId = await newStudy();
    const draft = await createPromptDraft(ctx, draftInput(studyId));
    const updated = await updatePromptDraft(ctx, draft.id, { promptText: "Translate it.", name: "Renamed" });
    expect(updated).toMatchObject({ promptText: "Translate it.", name: "Renamed", status: "draft", versionNumber: 1 });
    const audit = await auditRows(draft.id);
    expect(audit.map((row) => row.action)).toEqual(["ai_prompt.create", "ai_prompt.update_draft"]);
    expect(audit[1]?.beforeJson).toMatchObject({ name: "Default translation" });
    expect(audit[1]?.afterJson).toMatchObject({ name: "Renamed", promptText: "Translate it." });
  });

  it("rejects an unknown placeholder in a translation or TTS prompt, on create and on update", async () => {
    const studyId = await newStudy();
    await expect(
      createPromptDraft(ctx, draftInput(studyId, { promptText: "Translate for {{participant_name}}." })),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("{{participant_name}}"),
      details: { unknownPlaceholders: ["participant_name"] },
    });
    const draft = await createPromptDraft(ctx, draftInput(studyId));
    await expect(updatePromptDraft(ctx, draft.id, { promptText: "Use {{dialect}}." })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    // {{source_language}} is a translation placeholder, not a TTS one.
    await expect(
      createPromptDraft(ctx, draftInput(studyId, { key: "tts_baseline", stage: "tts", promptText: "Speak {{source_language}}." })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The ASR context text is sent as written, so braces are not checked there.
    const asr = await createPromptDraft(
      ctx,
      draftInput(studyId, { key: "asr_context", stage: "asr", conditionKey: null, promptText: "Words like {{this}}." }),
    );
    expect(asr.promptText).toBe("Words like {{this}}.");
  });

  it("rejects a bad key, a missing name and a stage that differs from earlier versions", async () => {
    const studyId = await newStudy();
    await expect(createPromptDraft(ctx, draftInput(studyId, { key: "Bad Key" }))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(createPromptDraft(ctx, draftInput(studyId, { name: "  " }))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const first = await createPromptDraft(ctx, draftInput(studyId));
    await activatePromptVersion(ctx, first.id);
    await expect(createPromptDraft(ctx, draftInput(studyId, { stage: "tts", promptText: "Speak." }))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("translation stage"),
    });
    await expect(createPromptDraft(ctx, draftInput(randomUUID()))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deletes a draft, and refuses to delete an active version", async () => {
    const studyId = await newStudy();
    const draft = await createPromptDraft(ctx, draftInput(studyId));
    expect(await deletePromptDraft(ctx, draft.id)).toEqual({ deleted: true, id: draft.id });
    await expect(getPromptVersion(ctx, draft.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const audit = await auditRows(draft.id);
    expect(audit.map((row) => row.action)).toEqual(["ai_prompt.create", "ai_prompt.delete_draft"]);
    expect(audit[1]).toMatchObject({
      entityType: "ai_prompt_version",
      actorLabel: "admin",
      beforeJson: { status: "draft", key: draft.key, versionNumber: 1, promptText: draft.promptText },
      afterJson: { deleted: true },
    });

    const next = await createPromptDraft(ctx, draftInput(studyId));
    await activatePromptVersion(ctx, next.id);
    await expect(deletePromptDraft(ctx, next.id)).rejects.toMatchObject({ code: "IMMUTABLE_RECORD" });
  });
});

describe("prompt activation", () => {
  it("activates a draft and retires the previous active version in the same step", async () => {
    const studyId = await newStudy();
    const v1 = await createPromptDraft(ctx, draftInput(studyId));
    const first = await activatePromptVersion(ctx, v1.id);
    expect(first.prompt).toMatchObject({ status: "active", versionNumber: 1 });
    expect(first.retired).toBeNull();
    expect(first.prompt.activatedAt?.toISOString()).toBe(t.clock.now().toISOString());

    t.clock.advance(60_000);
    const v2 = await clonePromptVersion(ctx, v1.id);
    expect(v2).toMatchObject({ versionNumber: 2, status: "draft", promptText: v1.promptText });
    await updatePromptDraft(ctx, v2.id, { promptText: "Translate it differently." });
    const second = await activatePromptVersion(ctx, v2.id);

    expect(second.prompt).toMatchObject({ id: v2.id, status: "active" });
    expect(second.retired).toMatchObject({ id: v1.id, status: "retired" });
    expect(second.retired?.retiredAt?.toISOString()).toBe(t.clock.now().toISOString());
    expect((await getActivePrompt(ctx, studyId, "translation_default"))?.id).toBe(v2.id);

    // The retired version kept its content.
    const old = await getPromptVersion(ctx, v1.id);
    expect(old.promptText).toBe(v1.promptText);
    expect(old.activatedAt?.toISOString()).toBe(first.prompt.activatedAt?.toISOString());

    expect((await auditRows(v2.id)).map((row) => row.action)).toEqual([
      "ai_prompt.create",
      "ai_prompt.update_draft",
      "ai_prompt.activate",
    ]);
    expect((await auditRows(v1.id)).map((row) => row.action)).toEqual([
      "ai_prompt.create",
      "ai_prompt.activate",
      "ai_prompt.retire",
    ]);
  });

  it("keeps one active version per key when two drafts are activated at the same time", async () => {
    const studyId = await newStudy();
    const v1 = await createPromptDraft(ctx, draftInput(studyId));
    await activatePromptVersion(ctx, v1.id);
    const v2 = await clonePromptVersion(ctx, v1.id);
    // A second draft cannot be made through the service, so it is inserted directly.
    const [v3] = await ctx.db
      .insert(aiPromptVersions)
      .values({ studyId, key: v1.key, stage: "translation", versionNumber: 3, name: "v3", promptText: "Third." })
      .returning();

    const results = await Promise.allSettled([activatePromptVersion(ctx, v2.id), activatePromptVersion(ctx, v3!.id)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    const rows = await listPromptVersions(ctx, { studyId, key: v1.key });
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "retired")).toHaveLength(2);
    expect(rows.filter((row) => row.status === "draft")).toHaveLength(0);
  });

  it("activates the same draft only once when the request is sent twice", async () => {
    const studyId = await newStudy();
    const draft = await createPromptDraft(ctx, draftInput(studyId));
    const results = await Promise.allSettled([activatePromptVersion(ctx, draft.id), activatePromptVersion(ctx, draft.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "INVALID_STATE" });
    expect((await auditRows(draft.id)).filter((row) => row.action === "ai_prompt.activate")).toHaveLength(1);
  });

  it("does not allow editing or re-activating an active or retired version", async () => {
    const studyId = await newStudy();
    const v1 = await createPromptDraft(ctx, draftInput(studyId));
    await activatePromptVersion(ctx, v1.id);
    await expect(updatePromptDraft(ctx, v1.id, { promptText: "Changed." })).rejects.toMatchObject({
      code: "IMMUTABLE_RECORD",
      message: expect.stringContaining("active"),
    });
    const v2 = await clonePromptVersion(ctx, v1.id);
    await activatePromptVersion(ctx, v2.id);
    await expect(updatePromptDraft(ctx, v1.id, { name: "Changed" })).rejects.toMatchObject({ code: "IMMUTABLE_RECORD" });
    await expect(activatePromptVersion(ctx, v1.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await getPromptVersion(ctx, v1.id)).promptText).toBe(v1.promptText);

    // The database trigger is the safety net when code bypasses the service.
    await expect(
      ctx.db.update(aiPromptVersions).set({ promptText: "Bypass." }).where(eq(aiPromptVersions.id, v1.id)),
    ).rejects.toThrow();
  });

  it("refuses to activate an empty translation prompt", async () => {
    const studyId = await newStudy();
    const draft = await createPromptDraft(ctx, draftInput(studyId, { promptText: "  " }));
    await expect(activatePromptVersion(ctx, draft.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("leaves old model runs pointing at the old prompt version", async () => {
    const studyId = await newStudy();
    const { prompts, configs } = await insertActiveAiConfigs(ctx.db, { studyId });
    const run = await insertModelRun(ctx.db, {
      sourceEntityType: "transcript_revision",
      sourceEntityId: randomUUID(),
      modelConfigId: configs.translationDefault.id,
      promptVersionId: prompts.translationDefault.id,
      status: "succeeded",
      finishedAt: new Date(),
    });

    const draft = await clonePromptVersion(ctx, prompts.translationDefault.id);
    await updatePromptDraft(ctx, draft.id, { promptText: "A new instruction." });
    await activatePromptVersion(ctx, draft.id);

    const [after] = await ctx.db.select().from(modelRuns).where(eq(modelRuns.id, run.id));
    expect(after).toEqual(run);
    const oldPrompt = await getPromptVersion(ctx, prompts.translationDefault.id);
    expect(oldPrompt).toMatchObject({ status: "retired", promptText: prompts.translationDefault.promptText });
  });

  it("does not change any active model config, and reports the configs that still use the old version", async () => {
    const studyId = await newStudy();
    const { prompts, configs } = await insertActiveAiConfigs(ctx.db, { studyId });
    const before = await ctx.db.select().from(modelConfigs).where(eq(modelConfigs.studyId, studyId)).orderBy(modelConfigs.key);

    const draft = await clonePromptVersion(ctx, prompts.translationDefault.id);
    const result = await activatePromptVersion(ctx, draft.id);

    const after = await ctx.db.select().from(modelConfigs).where(eq(modelConfigs.studyId, studyId)).orderBy(modelConfigs.key);
    expect(after).toEqual(before);
    const stillPinned = after.find((row) => row.id === configs.translationDefault.id);
    expect(stillPinned).toMatchObject({ status: "active", promptVersionId: prompts.translationDefault.id });
    expect(result.configsOnOtherVersions.map((row) => row.id)).toEqual([configs.translationDefault.id]);
    // No audit row was written for a model config.
    const configAudit = await ctx.db
      .select()
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.entityType, "model_config"), eq(adminAuditLog.entityId, configs.translationDefault.id)));
    expect(configAudit).toHaveLength(0);
  });
});

describe("retiring a prompt", () => {
  it("is refused while an active model config uses the version", async () => {
    const studyId = await newStudy();
    const { prompts } = await insertActiveAiConfigs(ctx.db, { studyId });
    await expect(retirePromptVersion(ctx, prompts.translationDefault.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("translation_default v1"),
    });
    expect((await getPromptVersion(ctx, prompts.translationDefault.id)).status).toBe("active");
  });

  it("retires an unused active version and writes an audit row", async () => {
    const studyId = await newStudy();
    const draft = await createPromptDraft(ctx, draftInput(studyId));
    await expect(retirePromptVersion(ctx, draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await activatePromptVersion(ctx, draft.id);
    const retired = await retirePromptVersion(ctx, draft.id);
    expect(retired.status).toBe("retired");
    expect(retired.retiredAt).not.toBeNull();
    expect(await getActivePrompt(ctx, studyId, draft.key)).toBeNull();
    expect((await auditRows(draft.id)).map((row) => row.action)).toEqual([
      "ai_prompt.create",
      "ai_prompt.activate",
      "ai_prompt.retire",
    ]);
    await expect(retirePromptVersion(ctx, draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("listing and comparing", () => {
  it("lists versions by key, newest first, with filters", async () => {
    const studyId = await newStudy();
    const { prompts } = await insertActiveAiConfigs(ctx.db, { studyId });
    await clonePromptVersion(ctx, prompts.ttsBaseline.id);
    const all = await listPromptVersions(ctx, { studyId });
    expect(all.map((row) => `${row.key} v${row.versionNumber}`)).toEqual([
      "asr_context v1",
      "translation_default v1",
      "translation_preserve v1",
      "tts_baseline v2",
      "tts_baseline v1",
    ]);
    expect((await listPromptVersions(ctx, { studyId, stage: "translation" })).length).toBe(2);
    expect((await listPromptVersions(ctx, { studyId, key: "tts_baseline" })).length).toBe(2);
  });

  it("returns the line and word level difference between two versions", async () => {
    const studyId = await newStudy();
    const v1 = await createPromptDraft(ctx, draftInput(studyId, { promptText: "Translate the text.\nReturn only the translation." }));
    await activatePromptVersion(ctx, v1.id);
    const v2 = await clonePromptVersion(ctx, v1.id);
    await updatePromptDraft(ctx, v2.id, { promptText: "Translate the text.\nKeep the register.\nReturn only the translation." });

    const diff = await diffPromptVersions(ctx, v1.id, v2.id);
    expect(diff.a).toMatchObject({ versionNumber: 1, status: "active" });
    expect(diff.b).toMatchObject({ versionNumber: 2, status: "draft" });
    expect(diff.identical).toBe(false);
    expect(diff.lines).toEqual([
      { type: "unchanged", value: "Translate the text.\n" },
      { type: "added", value: "Keep the register.\n" },
      { type: "unchanged", value: "Return only the translation." },
    ]);
    expect(diff.words.filter((part) => part.type === "added").map((part) => part.value).join("")).toContain("register");
    expect(diff.fields.filter((field) => field.changed).map((field) => field.field)).toEqual(["promptText"]);
    // The parts give back both texts exactly.
    const join = (skip: string) => diff.words.filter((p) => p.type !== skip).map((p) => p.value).join("");
    expect(join("added")).toBe(v1.promptText);
    expect(join("removed")).toBe("Translate the text.\nKeep the register.\nReturn only the translation.");

    const same = await diffPromptVersions(ctx, v1.id, v1.id);
    expect(same.identical).toBe(true);
    await expect(diffPromptVersions(ctx, v1.id, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("resolves the only study when none is named", async () => {
    const study = await resolveStudy(ctx);
    expect(study.id).toBeTruthy();
    await expect(resolveStudy(ctx, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
