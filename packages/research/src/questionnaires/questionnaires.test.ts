import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminAuditLog,
  isImmutableRecordError,
  questionnaireAnswers,
  questionnaireItems,
  questionnaireResponses,
  questionnaireVersions,
} from "@dialect/db";
import {
  insertDraftProtocol,
  insertPublishedProtocol,
  insertQuestionnaire,
  insertSession,
  insertStudy,
} from "@dialect/db/testing-builders";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  addItem,
  cloneQuestionnaireVersion,
  createQuestionnaireDraft,
  deleteItem,
  deleteQuestionnaireDraft,
  diffQuestionnaireVersions,
  findPreviousPublishedVersionId,
  getQuestionnaireResponsesForSession,
  getQuestionnaireVersion,
  listQuestionnaires,
  moveItem,
  publishQuestionnaireVersion,
  retireQuestionnaireVersion,
  saveQuestionnaireDraft,
  updateItem,
  updateQuestionnaireDraft,
} from "./index";

let t: TestServiceContext;

beforeAll(async () => {
  t = await createTestServiceContext();
});

afterAll(async () => {
  await t.cleanup();
});

const newStudy = async () => (await insertStudy(t.ctx.db)).id;

async function auditRows(entityId: string) {
  return t.ctx.db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.entityId, entityId))
    .orderBy(asc(adminAuditLog.createdAt), asc(adminAuditLog.id));
}

// A draft with three valid items: a (likert), b (single choice), c (free text).
async function draftWithItems(studyId: string, key = "post_recording") {
  const draft = await createQuestionnaireDraft(t.adminCtx, { studyId, key, name: "Post recording" });
  await addItem(t.adminCtx, draft.id, {
    itemKey: "a",
    type: "likert",
    prompt: "How natural?",
    required: true,
    config: { scaleMin: 1, scaleMax: 5, scaleMinLabel: "Not at all", scaleMaxLabel: "Completely" },
  });
  await addItem(t.adminCtx, draft.id, {
    itemKey: "b",
    type: "single_choice",
    prompt: "Which one?",
    config: {
      options: [
        { value: "x", label: "Option X" },
        { value: "y", label: "Option Y" },
      ],
    },
  });
  return addItem(t.adminCtx, draft.id, { itemKey: "c", type: "free_text", prompt: "Comments?" });
}

describe("draft life cycle", () => {
  it("creates a draft under any key with the next version number and an audit row", async () => {
    const studyId = await newStudy();
    const draft = await createQuestionnaireDraft(t.adminCtx, {
      studyId,
      key: "source_speaker_evaluation",
      name: "Source speaker evaluation",
      description: "For a later study.",
    });
    expect(draft).toMatchObject({
      key: "source_speaker_evaluation",
      versionNumber: 1,
      status: "draft",
      name: "Source speaker evaluation",
      description: "For a later study.",
      items: [],
      itemCount: 0,
      publishedAt: null,
      createdByLabel: "admin",
      createdAt: t.clock.now().toISOString(),
    });
    const audit = await auditRows(draft.id);
    expect(audit.map((row) => row.action)).toEqual(["questionnaire.create"]);
    expect(audit[0]).toMatchObject({ entityType: "questionnaire_version", actorLabel: "admin" });
  });

  it("rejects a malformed key", async () => {
    const studyId = await newStudy();
    await expect(
      createQuestionnaireDraft(t.adminCtx, { studyId, key: "Not A Key", name: "X" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows one draft per key at a time", async () => {
    const studyId = await newStudy();
    const first = await createQuestionnaireDraft(t.adminCtx, { studyId, key: "background", name: "Background" });
    await expect(
      createQuestionnaireDraft(t.adminCtx, { studyId, key: "background", name: "Again" }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { draftVersionId: first.id } });
    // Another key is independent.
    const other = await createQuestionnaireDraft(t.adminCtx, { studyId, key: "post_recording", name: "Post" });
    expect(other.versionNumber).toBe(1);
  });

  it("updates the name and description of a draft", async () => {
    const studyId = await newStudy();
    const draft = await createQuestionnaireDraft(t.adminCtx, { studyId, key: "background", name: "Background" });
    const updated = await updateQuestionnaireDraft(t.adminCtx, draft.id, { name: "Background, revised", description: "New" });
    expect(updated).toMatchObject({ name: "Background, revised", description: "New" });
    const audit = await auditRows(draft.id);
    expect(audit.map((row) => row.action)).toEqual(["questionnaire.create", "questionnaire.update_draft"]);
    expect(audit[1]!.beforeJson).toMatchObject({ name: "Background" });
    expect(audit[1]!.afterJson).toMatchObject({ name: "Background, revised", change: "details" });
  });

  it("adds, updates, moves and deletes items with a dense order", async () => {
    const studyId = await newStudy();
    let version = await draftWithItems(studyId);
    expect(version.items.map((item) => [item.itemKey, item.orderIndex])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    const [a, b, c] = version.items;

    version = await moveItem(t.adminCtx, c!.id, "up");
    expect(version.items.map((item) => item.itemKey)).toEqual(["a", "c", "b"]);
    version = await moveItem(t.adminCtx, c!.id, "up");
    expect(version.items.map((item) => item.itemKey)).toEqual(["c", "a", "b"]);
    // Already first: nothing changes.
    version = await moveItem(t.adminCtx, c!.id, "up");
    expect(version.items.map((item) => item.itemKey)).toEqual(["c", "a", "b"]);
    version = await moveItem(t.adminCtx, a!.id, "down");
    expect(version.items.map((item) => [item.itemKey, item.orderIndex])).toEqual([
      ["c", 0],
      ["b", 1],
      ["a", 2],
    ]);

    version = await updateItem(t.adminCtx, b!.id, { prompt: "Which one, exactly?", required: true, helpText: "Pick one." });
    expect(version.items[1]).toMatchObject({ itemKey: "b", prompt: "Which one, exactly?", required: true, helpText: "Pick one." });

    version = await deleteItem(t.adminCtx, c!.id);
    expect(version.items.map((item) => [item.itemKey, item.orderIndex])).toEqual([
      ["b", 0],
      ["a", 1],
    ]);
    expect(version.itemCount).toBe(2);
  });

  it("keeps item keys unique within a version and derives a stable slug", async () => {
    const studyId = await newStudy();
    const draft = await createQuestionnaireDraft(t.adminCtx, { studyId, key: "background", name: "Background" });
    let version = await addItem(t.adminCtx, draft.id, { type: "boolean", prompt: "Did it feel natural?" });
    version = await addItem(t.adminCtx, draft.id, { type: "boolean", prompt: "Did it feel natural?" });
    expect(version.items.map((item) => item.itemKey)).toEqual(["did_it_feel_natural", "did_it_feel_natural_2"]);
    await expect(
      addItem(t.adminCtx, draft.id, { itemKey: "did_it_feel_natural", type: "boolean", prompt: "Again?" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      updateItem(t.adminCtx, version.items[1]!.id, { itemKey: "did_it_feel_natural" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Changing the prompt does not change the key.
    version = await updateItem(t.adminCtx, version.items[0]!.id, { prompt: "Completely different wording" });
    expect(version.items[0]!.itemKey).toBe("did_it_feel_natural");
  });

  it("saves a whole draft: update, add, delete, reorder and exchange keys in one step", async () => {
    const studyId = await newStudy();
    const before = await draftWithItems(studyId);
    const [a, b] = before.items;
    const saved = await saveQuestionnaireDraft(t.adminCtx, before.id, {
      name: "Renamed",
      description: null,
      items: [
        { itemKey: "d", type: "boolean", prompt: "New?", required: false, config: {} },
        // a and b exchange their keys.
        { id: b!.id, itemKey: "a", type: b!.type, prompt: b!.prompt, required: true, config: b!.config },
        { id: a!.id, itemKey: "b", type: a!.type, prompt: a!.prompt, required: true, config: a!.config },
      ],
    });
    expect(saved.name).toBe("Renamed");
    expect(saved.items.map((item) => [item.itemKey, item.orderIndex, item.type])).toEqual([
      ["d", 0, "boolean"],
      ["a", 1, "single_choice"],
      ["b", 2, "likert"],
    ]);
    expect(saved.items[1]!.id).toBe(b!.id);

    await expect(
      saveQuestionnaireDraft(t.adminCtx, before.id, {
        items: [
          { itemKey: "same", type: "boolean", prompt: "1", required: false, config: {} },
          { itemKey: "same", type: "boolean", prompt: "2", required: false, config: {} },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // The failed save changed nothing.
    expect((await getQuestionnaireVersion(t.ctx, before.id)).items).toHaveLength(3);
  });

  it("deletes a draft with its items, and not a draft that a protocol selects", async () => {
    const studyId = await newStudy();
    const draft = await draftWithItems(studyId);
    expect(await deleteQuestionnaireDraft(t.adminCtx, draft.id)).toEqual({ deleted: true, id: draft.id });
    await expect(getQuestionnaireVersion(t.ctx, draft.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const audit = await auditRows(draft.id);
    expect(audit.at(-1)).toMatchObject({ action: "questionnaire.delete_draft", afterJson: { deleted: true } });

    const selected = await draftWithItems(studyId);
    await insertDraftProtocol(t.ctx.db, { studyId, postQuestionnaireVersionId: selected.id });
    await expect(deleteQuestionnaireDraft(t.adminCtx, selected.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns NOT_FOUND for an unknown version or item", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(getQuestionnaireVersion(t.ctx, missing)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateItem(t.adminCtx, missing, { prompt: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(publishQuestionnaireVersion(t.adminCtx, missing)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("publishing", () => {
  it("refuses an empty draft and reports every invalid item", async () => {
    const studyId = await newStudy();
    const draft = await createQuestionnaireDraft(t.adminCtx, { studyId, key: "background", name: "Background" });
    await expect(publishQuestionnaireVersion(t.adminCtx, draft.id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { problems: ["Add at least one item."] },
    });

    await addItem(t.adminCtx, draft.id, { itemKey: "choice", type: "single_choice", prompt: "Pick" });
    await addItem(t.adminCtx, draft.id, {
      itemKey: "scale",
      type: "likert",
      prompt: "Rate",
      config: { scaleMin: 5, scaleMax: 1 },
    });
    await addItem(t.adminCtx, draft.id, { itemKey: "blank", type: "boolean", prompt: "" });
    const error = await publishQuestionnaireVersion(t.adminCtx, draft.id).catch((caught) => caught);
    expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(error.details.problems).toEqual([
      'Item "choice": Add at least two options.',
      'Item "scale": Scale minimum must be lower than scale maximum.',
      'Item "blank": the prompt is empty.',
    ]);
    expect((await getQuestionnaireVersion(t.ctx, draft.id)).status).toBe("draft");
  });

  it("publishes a valid draft, sets published_at and writes an audit row", async () => {
    const studyId = await newStudy();
    const draft = await draftWithItems(studyId);
    t.clock.advance(60_000);
    const published = await publishQuestionnaireVersion(t.adminCtx, draft.id);
    expect(published).toMatchObject({ status: "published", publishedAt: t.clock.now().toISOString() });
    const audit = await auditRows(draft.id);
    expect(audit.at(-1)).toMatchObject({ action: "questionnaire.publish", actorLabel: "admin" });
    expect(audit.at(-1)!.afterJson).toMatchObject({ status: "published", items: [{ itemKey: "a" }, { itemKey: "b" }, { itemKey: "c" }] });
    await expect(publishQuestionnaireVersion(t.adminCtx, draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("does not change any protocol", async () => {
    const studyId = await newStudy();
    const v1 = await insertQuestionnaire(t.ctx.db, { studyId, key: "post_recording" });
    const { protocol } = await insertPublishedProtocol(t.ctx.db, { studyId, postQuestionnaireVersionId: v1.version.id });
    const draft = await cloneQuestionnaireVersion(t.adminCtx, v1.version.id);
    await publishQuestionnaireVersion(t.adminCtx, draft.id);
    const detail = await getQuestionnaireVersion(t.ctx, v1.version.id);
    expect(detail.usedByProtocols).toEqual([
      {
        protocolVersionId: protocol.id,
        versionNumber: protocol.versionNumber,
        name: protocol.name,
        status: "published",
        isCurrent: true,
        role: "post_recording",
      },
    ]);
    expect((await getQuestionnaireVersion(t.ctx, draft.id)).usedByProtocols).toEqual([]);
  });

  it("makes the published version and its items immutable (service checks)", async () => {
    const studyId = await newStudy();
    const draft = await draftWithItems(studyId);
    const published = await publishQuestionnaireVersion(t.adminCtx, draft.id);
    const itemId = published.items[0]!.id;
    const immutable = { code: "IMMUTABLE_RECORD" };
    await expect(updateQuestionnaireDraft(t.adminCtx, draft.id, { name: "Changed" })).rejects.toMatchObject(immutable);
    await expect(saveQuestionnaireDraft(t.adminCtx, draft.id, { items: [] })).rejects.toMatchObject(immutable);
    await expect(addItem(t.adminCtx, draft.id, { type: "boolean", prompt: "New?" })).rejects.toMatchObject(immutable);
    await expect(updateItem(t.adminCtx, itemId, { prompt: "Changed" })).rejects.toMatchObject(immutable);
    await expect(deleteItem(t.adminCtx, itemId)).rejects.toMatchObject(immutable);
    await expect(moveItem(t.adminCtx, itemId, "down")).rejects.toMatchObject(immutable);
    await expect(deleteQuestionnaireDraft(t.adminCtx, draft.id)).rejects.toMatchObject(immutable);
    const after = await getQuestionnaireVersion(t.ctx, draft.id);
    expect(after.items).toEqual(published.items);
    expect(after.name).toBe(published.name);
  });

  it("is protected by the database triggers as well", async () => {
    const studyId = await newStudy();
    const draft = await draftWithItems(studyId);
    const published = await publishQuestionnaireVersion(t.adminCtx, draft.id);
    const attempts = [
      () => t.ctx.db.update(questionnaireVersions).set({ name: "Changed" }).where(eq(questionnaireVersions.id, draft.id)),
      () => t.ctx.db.update(questionnaireItems).set({ prompt: "Changed" }).where(eq(questionnaireItems.id, published.items[0]!.id)),
      () => t.ctx.db.delete(questionnaireItems).where(eq(questionnaireItems.id, published.items[0]!.id)),
      () =>
        t.ctx.db
          .insert(questionnaireItems)
          .values({ questionnaireVersionId: draft.id, itemKey: "late", type: "boolean", prompt: "Late?", orderIndex: 9 }),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => null,
        (caught) => caught,
      );
      expect(isImmutableRecordError(error)).toBe(true);
    }
  });
});

describe("cloning", () => {
  it("copies a published version into a new draft and keeps the item keys", async () => {
    const studyId = await newStudy();
    const draft = await draftWithItems(studyId);
    const v1 = await publishQuestionnaireVersion(t.adminCtx, draft.id);
    const v2 = await cloneQuestionnaireVersion(t.adminCtx, v1.id);
    expect(v2).toMatchObject({ key: v1.key, versionNumber: 2, status: "draft", name: v1.name, publishedAt: null });
    const strip = ({ id: _id, ...rest }: (typeof v1.items)[number]) => rest;
    expect(v2.items.map(strip)).toEqual(v1.items.map(strip));
    expect(v2.items.map((item) => item.id)).not.toEqual(v1.items.map((item) => item.id));
    const audit = await auditRows(v2.id);
    expect(audit[0]).toMatchObject({ action: "questionnaire.create", beforeJson: { clonedFromVersionId: v1.id } });

    // One draft per key also applies to cloning.
    await expect(cloneQuestionnaireVersion(t.adminCtx, v1.id)).rejects.toMatchObject({ code: "CONFLICT" });

    // Editing the clone leaves version 1 unchanged.
    await updateItem(t.adminCtx, v2.items[0]!.id, { prompt: "Reworded" });
    expect((await getQuestionnaireVersion(t.ctx, v1.id)).items[0]!.prompt).toBe("How natural?");
  });

  it("lists questionnaires grouped by key with the newest version first", async () => {
    const studyId = await newStudy();
    const v1 = await publishQuestionnaireVersion(t.adminCtx, (await draftWithItems(studyId, "post_recording")).id);
    const v2 = await cloneQuestionnaireVersion(t.adminCtx, v1.id);
    await insertQuestionnaire(t.ctx.db, { studyId, key: "background" });
    const groups = await listQuestionnaires(t.ctx, studyId);
    expect(groups.map((group) => group.key)).toEqual(["background", "post_recording"]);
    expect(groups[1]!.versions.map((version) => [version.id, version.versionNumber, version.status, version.itemCount])).toEqual([
      [v2.id, 2, "draft", 3],
      [v1.id, 1, "published", 3],
    ]);
    expect(await listQuestionnaires(t.ctx, await newStudy())).toEqual([]);
  });
});

describe("retiring", () => {
  it("refuses while the current published protocol uses the version, and allows it afterwards", async () => {
    const studyId = await newStudy();
    const v1 = await insertQuestionnaire(t.ctx.db, { studyId, key: "background" });
    await insertPublishedProtocol(t.ctx.db, { studyId, backgroundQuestionnaireVersionId: v1.version.id });
    await expect(retireQuestionnaireVersion(t.adminCtx, v1.version.id)).rejects.toMatchObject({ code: "CONFLICT" });

    // A newer protocol without this questionnaire becomes the current one.
    await insertPublishedProtocol(t.ctx.db, { studyId });
    t.clock.advance(1000);
    const retired = await retireQuestionnaireVersion(t.adminCtx, v1.version.id);
    expect(retired).toMatchObject({ status: "retired", retiredAt: t.clock.now().toISOString() });
    expect(retired.publishedAt).not.toBeNull();
    const audit = await auditRows(v1.version.id);
    expect(audit.map((row) => row.action)).toEqual(["questionnaire.retire"]);
  });

  it("only retires a published version", async () => {
    const studyId = await newStudy();
    const draft = await draftWithItems(studyId);
    await expect(retireQuestionnaireVersion(t.adminCtx, draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await publishQuestionnaireVersion(t.adminCtx, draft.id);
    await retireQuestionnaireVersion(t.adminCtx, draft.id);
    await expect(retireQuestionnaireVersion(t.adminCtx, draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    // A retired version can still be cloned.
    expect((await cloneQuestionnaireVersion(t.adminCtx, draft.id)).versionNumber).toBe(2);
  });
});

describe("differences", () => {
  it("reports added, removed, reworded and rescaled items against the previous published version", async () => {
    const studyId = await newStudy();
    const v1 = await publishQuestionnaireVersion(t.adminCtx, (await draftWithItems(studyId)).id);
    const v2 = await cloneQuestionnaireVersion(t.adminCtx, v1.id);
    const [a, b, c] = v2.items;
    await updateItem(t.adminCtx, a!.id, { prompt: "How natural did it feel?", config: { scaleMin: 1, scaleMax: 7 } });
    await updateItem(t.adminCtx, b!.id, {
      config: { options: [...(b!.config.options ?? []), { value: "z", label: "Option Z" }] },
    });
    await deleteItem(t.adminCtx, c!.id);
    await addItem(t.adminCtx, v2.id, { itemKey: "d", type: "boolean", prompt: "New?" });
    await updateQuestionnaireDraft(t.adminCtx, v2.id, { name: "Post recording, second edition" });

    expect(await findPreviousPublishedVersionId(t.ctx, v2.id)).toBe(v1.id);
    expect(await findPreviousPublishedVersionId(t.ctx, v1.id)).toBeNull();

    const diff = await diffQuestionnaireVersions(t.ctx, v1.id, v2.id);
    expect(diff.from).toMatchObject({ id: v1.id, versionNumber: 1, status: "published" });
    expect(diff.to).toMatchObject({ id: v2.id, versionNumber: 2, status: "draft" });
    expect(diff.nameChanged).toBe(true);
    expect(diff.descriptionChanged).toBe(false);
    expect(diff.added.map((item) => item.itemKey)).toEqual(["d"]);
    expect(diff.removed.map((item) => item.itemKey)).toEqual(["c"]);
    expect(diff.changed.map((entry) => [entry.itemKey, entry.changes])).toEqual([
      ["a", ["wording", "scale"]],
      ["b", ["options"]],
    ]);
    expect(diff.changed[0]!.before.prompt).toBe("How natural?");
    expect(diff.changed[0]!.after.prompt).toBe("How natural did it feel?");
    expect(diff.identical).toBe(false);
  });

  it("reports an unchanged clone as identical and a first version as all added", async () => {
    const studyId = await newStudy();
    const v1 = await publishQuestionnaireVersion(t.adminCtx, (await draftWithItems(studyId)).id);
    const v2 = await cloneQuestionnaireVersion(t.adminCtx, v1.id);
    expect(await diffQuestionnaireVersions(t.ctx, v1.id, v2.id)).toMatchObject({
      identical: true,
      added: [],
      removed: [],
      changed: [],
      unchangedCount: 3,
    });
    const first = await diffQuestionnaireVersions(t.ctx, null, v1.id);
    expect(first.from).toBeNull();
    expect(first.added.map((item) => item.itemKey)).toEqual(["a", "b", "c"]);
    expect(first.identical).toBe(false);
  });
});

describe("getQuestionnaireResponsesForSession", () => {
  it("returns every item with the stored answer and resolved option labels", async () => {
    const studyId = await newStudy();
    const { version, items } = await insertQuestionnaire(t.ctx.db, {
      studyId,
      key: "background",
      name: "Background",
      items: [
        {
          itemKey: "age_range",
          type: "single_choice",
          prompt: "Age range?",
          required: true,
          configJson: { options: [{ value: "25_34", label: "25 to 34" }, { value: "35_44", label: "35 to 44" }] },
        },
        {
          itemKey: "languages",
          type: "multi_choice",
          prompt: "Languages?",
          configJson: { options: [{ value: "fi", label: "Finnish" }, { value: "sv", label: "Swedish" }] },
        },
        { itemKey: "natural", type: "likert", prompt: "Natural?", configJson: { scaleMin: 1, scaleMax: 5 } },
        { itemKey: "changed", type: "boolean", prompt: "Changed?" },
        { itemKey: "years", type: "integer", prompt: "Years?" },
        { itemKey: "comment", type: "free_text", prompt: "Comment?" },
      ],
    });
    const { protocol } = await insertPublishedProtocol(t.ctx.db, { studyId, backgroundQuestionnaireVersionId: version.id });
    const session = await insertSession(t.ctx.db, { studyId, protocolVersionId: protocol.id });
    const submittedAt = new Date("2026-10-03T10:00:00.000Z");
    const [response] = await t.ctx.db
      .insert(questionnaireResponses)
      .values({ sessionId: session.id, questionnaireVersionId: version.id, submittedAt })
      .returning();
    const byKey = new Map(items.map((item) => [item.itemKey, item.id]));
    const stored: Record<string, unknown> = { age_range: "25_34", languages: ["fi", "sv"], natural: 4, changed: false, years: 12 };
    await t.ctx.db.insert(questionnaireAnswers).values(
      Object.entries(stored).map(([key, valueJson]) => ({
        responseId: response!.id,
        questionnaireItemId: byKey.get(key)!,
        valueJson,
      })),
    );

    const result = await getQuestionnaireResponsesForSession(t.ctx, session.id);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      responseId: response!.id,
      submittedAt: submittedAt.toISOString(),
      questionnaire: { versionId: version.id, key: "background", versionNumber: 1, name: "Background" },
    });
    expect(result[0]!.answers.map((answer) => [answer.itemKey, answer.prompt, answer.value, answer.display])).toEqual([
      ["age_range", "Age range?", "25_34", "25 to 34"],
      ["languages", "Languages?", ["fi", "sv"], "Finnish; Swedish"],
      ["natural", "Natural?", 4, "4 (scale 1 to 5)"],
      ["changed", "Changed?", false, "No"],
      ["years", "Years?", 12, "12"],
      ["comment", "Comment?", null, null],
    ]);
  });

  it("returns an empty list for a session without submissions and NOT_FOUND for an unknown session", async () => {
    const studyId = await newStudy();
    const { protocol } = await insertPublishedProtocol(t.ctx.db, { studyId });
    const session = await insertSession(t.ctx.db, { studyId, protocolVersionId: protocol.id });
    expect(await getQuestionnaireResponsesForSession(t.ctx, session.id)).toEqual([]);
    await expect(
      getQuestionnaireResponsesForSession(t.ctx, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
