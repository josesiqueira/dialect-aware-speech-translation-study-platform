import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAuditLog, consentVersions } from "@dialect/db";
import { insertConsentVersion, insertDraftProtocol, insertStudy } from "@dialect/db/testing-builders";
import type { ServiceContext } from "../context";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  cloneConsentVersion,
  createConsentDraft,
  deleteConsentDraft,
  getConsentVersion,
  listConsentVersions,
  publishConsentVersion,
  updateConsentDraft,
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

const ITEMS = [
  { id: "participation", text: "I agree to take part.", required: true, scope: "participation" },
  { id: "voice_recording", text: "I agree that my voice is recorded.", required: true, scope: "voice_recording" },
  { id: "future_reuse", text: "My recordings may be reused.", required: false },
];

async function actions(entityId: string): Promise<string[]> {
  const rows = await ctx.db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.entityId, entityId))
    .orderBy(adminAuditLog.createdAt);
  return rows.map((row) => row.action);
}

describe("consent drafts", () => {
  it("creates a draft with the next version number, edits it and refuses a second draft", async () => {
    const study = await insertStudy(ctx.db);
    await insertConsentVersion(ctx.db, { studyId: study.id });
    const draft = await createConsentDraft(ctx, { studyId: study.id, title: " Consent form " });
    expect(draft).toMatchObject({
      versionNumber: 2,
      title: "Consent form",
      status: "draft",
      publishedAt: null,
      itemsJson: [],
      informationText: "",
      createdByLabel: "admin",
    });

    await expect(createConsentDraft(ctx, { studyId: study.id, title: "Another" })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { draftConsentVersionId: draft.id },
    });

    const updated = await updateConsentDraft(ctx, draft.id, {
      informationText: "What the study is about.",
      privacyNoticeUrl: "https://example.org/privacy",
      contactText: "researcher@example.org",
      items: ITEMS,
    });
    expect(updated.itemsJson).toEqual(ITEMS);
    expect(updated.privacyNoticeUrl).toBe("https://example.org/privacy");
    await expect(
      updateConsentDraft(ctx, draft.id, { items: [ITEMS[0]!, { ...ITEMS[1]!, id: "participation" }] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Nothing changed: no audit row.
    await updateConsentDraft(ctx, draft.id, { contactText: "researcher@example.org" });
    expect(await actions(draft.id)).toEqual(["consent.create", "consent.update_draft"]);
    const [auditRow] = (
      await ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, draft.id))
    ).filter((row) => row.action === "consent.update_draft");
    expect(auditRow?.beforeJson).toMatchObject({ informationText: "", itemsJson: [] });
    expect(auditRow?.afterJson).toMatchObject({ informationText: "What the study is about." });
    expect(auditRow?.actorLabel).toBe("admin");

    const list = await listConsentVersions(ctx, study.id);
    expect(list.map((row) => [row.versionNumber, row.status])).toEqual([
      [2, "draft"],
      [1, "published"],
    ]);
  });

  it("publishes only a complete draft", async () => {
    const study = await insertStudy(ctx.db);
    const draft = await createConsentDraft(ctx, {
      studyId: study.id,
      title: "Consent",
      items: [{ id: "optional_reuse", text: "", required: false }],
    });
    await expect(publishConsentVersion(ctx, draft.id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        problems: [
          "The information text is empty.",
          "At least one required consent item is needed.",
          'The item "optional_reuse" has no text.',
        ],
      },
    });
    expect((await getConsentVersion(ctx, draft.id)).publishedAt).toBeNull();

    await updateConsentDraft(ctx, draft.id, { informationText: "Information.", items: ITEMS });
    t.clock.set(new Date("2026-11-02T08:00:00.000Z"));
    const published = await publishConsentVersion(ctx, draft.id);
    expect(published).toMatchObject({ status: "published", publishedAt: new Date("2026-11-02T08:00:00.000Z") });
    expect(await actions(draft.id)).toEqual(["consent.create", "consent.update_draft", "consent.publish"]);
    await expect(publishConsentVersion(ctx, draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("a published consent version", () => {
  it("cannot be changed or deleted", async () => {
    const study = await insertStudy(ctx.db);
    const draft = await createConsentDraft(ctx, {
      studyId: study.id,
      title: "Consent",
      informationText: "Information.",
      items: ITEMS,
    });
    const published = await publishConsentVersion(ctx, draft.id);

    await expect(updateConsentDraft(ctx, draft.id, { title: "Changed" })).rejects.toMatchObject({
      code: "IMMUTABLE_RECORD",
    });
    await expect(updateConsentDraft(ctx, draft.id, { items: [] })).rejects.toThrow(/Clone it to a new draft/);
    await expect(deleteConsentDraft(ctx, draft.id)).rejects.toMatchObject({ code: "IMMUTABLE_RECORD" });

    const [row] = await ctx.db.select().from(consentVersions).where(eq(consentVersions.id, draft.id));
    expect(row).toMatchObject({ title: "Consent", itemsJson: ITEMS });
    expect(row?.publishedAt).toEqual(published.publishedAt);
  });

  it("is cloned into a draft that keeps the item ids", async () => {
    const study = await insertStudy(ctx.db);
    const source = await insertConsentVersion(ctx.db, {
      studyId: study.id,
      itemsJson: ITEMS,
      privacyNoticeUrl: "https://example.org/privacy",
      contactText: "Contact",
    });
    const clone = await cloneConsentVersion(ctx, source.id);
    expect(clone.id).not.toBe(source.id);
    expect(clone).toMatchObject({
      versionNumber: 2,
      status: "draft",
      title: source.title,
      informationText: source.informationText,
      privacyNoticeUrl: "https://example.org/privacy",
      contactText: "Contact",
    });
    expect(clone.itemsJson.map((item) => item.id)).toEqual(["participation", "voice_recording", "future_reuse"]);
    expect(clone.itemsJson).toEqual(ITEMS);

    // Editing the text of an item in the draft keeps its id and leaves the source alone.
    const edited = await updateConsentDraft(ctx, clone.id, {
      items: clone.itemsJson.map((item) => (item.id === "future_reuse" ? { ...item, text: "New wording." } : item)),
    });
    expect(edited.itemsJson.map((item) => item.id)).toEqual(["participation", "voice_recording", "future_reuse"]);
    expect((await getConsentVersion(ctx, source.id)).itemsJson).toEqual(ITEMS);

    const [createRow] = await ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, clone.id));
    expect(createRow?.action).toBe("consent.clone");
    expect(createRow?.beforeJson).toMatchObject({ clonedFromConsentVersionId: source.id });
  });
});

describe("deleteConsentDraft", () => {
  it("deletes a draft and records it", async () => {
    const study = await insertStudy(ctx.db);
    const draft = await createConsentDraft(ctx, { studyId: study.id, title: "Consent", items: ITEMS });
    expect(await deleteConsentDraft(ctx, draft.id)).toEqual({ deleted: true, id: draft.id, versionNumber: 1 });
    await expect(getConsentVersion(ctx, draft.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rows = await ctx.db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, draft.id));
    expect(rows.find((row) => row.action === "consent.delete_draft")?.afterJson).toEqual({ deleted: true });
    expect(rows.map((row) => row.action)).toEqual(["consent.create", "consent.delete_draft"]);
    // A new draft can be created afterwards.
    await expect(createConsentDraft(ctx, { studyId: study.id, title: "Again" })).resolves.toMatchObject({
      versionNumber: 1,
    });
  });

  it("refuses to delete a draft that a protocol selects", async () => {
    const study = await insertStudy(ctx.db);
    const draft = await createConsentDraft(ctx, { studyId: study.id, title: "Consent" });
    // Built directly: the protocol service only accepts published consent versions.
    await insertDraftProtocol(ctx.db, { studyId: study.id, consentVersionId: draft.id });
    await expect(deleteConsentDraft(ctx, draft.id)).rejects.toMatchObject({ code: "CONFLICT" });
    const usage = await getConsentVersion(ctx, draft.id);
    expect(usage.usedByProtocolVersions).toEqual([1]);
  });
});
