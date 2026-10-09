// Proves that the database itself enforces the scientific invariants
// (migrations 0002_immutability_triggers.sql and 0003_hardening_guards.sql,
// docs/DATA-MODEL.md). The rules added by 0003 are in hardening.test.ts.
// For each rule: the forbidden change fails, the allowed change succeeds.
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getPgError,
  IMMUTABLE_RECORD_SQLSTATE,
  INVALID_STATE_SQLSTATE,
  isCheckViolation,
  isImmutableRecordError,
  isUniqueViolation,
  triggerErrorReason,
} from "./errors";
import {
  adminAuditLog,
  aiPromptVersions,
  consentVersions,
  jobs,
  mediaAssets,
  modelConfigs,
  modelRuns,
  processingBatches,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireItems,
  questionnaireVersions,
  researchFlags,
  sessionConsents,
  sessions,
  studies,
  syntheses,
  taskPresentations,
  transcriptRevisions,
  transcripts,
  translations,
  utterances,
} from "./schema";
import { allowTestDataReset, deleteDemoAndTestData } from "./test-data-reset";
import { createTestDatabase, type TestDatabase } from "./testing";
import {
  emptyBatchSnapshot,
  insertActiveAiConfigs,
  insertConsentVersion,
  insertDraftProtocol,
  insertMediaAsset,
  insertModelRun,
  insertProcessingBatch,
  insertPublishedProtocol,
  insertQuestionnaire,
  insertSessionWithUtterance,
  insertStudy,
  insertSynthesis,
  insertTaskPresentation,
  insertTranscriptWithRevision,
  insertTranslation,
  publishProtocol,
  randomSha256,
} from "./testing-builders";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.cleanup();
});

async function failure(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the statement to fail, but it succeeded");
}

async function expectImmutable(action: () => Promise<unknown>, table?: string): Promise<void> {
  const error = await failure(action);
  const pgError = getPgError(error);
  expect(pgError?.code, pgError?.message).toBe(IMMUTABLE_RECORD_SQLSTATE);
  expect(pgError?.message).toMatch(/^IMMUTABLE_RECORD: /);
  if (table) expect(pgError?.message).toContain(`IMMUTABLE_RECORD: ${table}: `);
  expect(isImmutableRecordError(error)).toBe(true);
}

async function expectInvalidState(action: () => Promise<unknown>): Promise<void> {
  const error = await failure(action);
  const pgError = getPgError(error);
  expect(pgError?.code, pgError?.message).toBe(INVALID_STATE_SQLSTATE);
  expect(pgError?.message).toMatch(/^INVALID_STATE: /);
}

async function expectUnique(action: () => Promise<unknown>, constraint: string): Promise<void> {
  const error = await failure(action);
  expect(getPgError(error)?.constraint).toBe(constraint);
  expect(isUniqueViolation(error, constraint)).toBe(true);
}

async function expectCheck(action: () => Promise<unknown>, constraint: string): Promise<void> {
  const error = await failure(action);
  expect(getPgError(error)?.constraint).toBe(constraint);
  expect(isCheckViolation(error, constraint)).toBe(true);
}

// Builds a full lineage in one mode: utterance, transcript revision, batch,
// translation, synthesis.
async function insertLineage(mode: "research" | "demo" | "test") {
  const collected = await insertSessionWithUtterance(t.db, { session: { mode } });
  const { transcript, revision } = await insertTranscriptWithRevision(t.db, {
    utteranceId: collected.utterance.id,
  });
  const batch = await insertProcessingBatch(t.db, {
    studyId: collected.study.id,
    dataMode: mode,
    status: "completed",
  });
  const { translation, modelRun: translationRun } = await insertTranslation(t.db, {
    sourceTranscriptRevisionId: revision.id,
    processingBatchId: batch.id,
  });
  const { synthesis, media: ttsMedia } = await insertSynthesis(t.db, {
    studyId: collected.study.id,
    translationId: translation.id,
    processingBatchId: batch.id,
  });
  return { ...collected, transcript, revision, batch, translation, translationRun, synthesis, ttsMedia };
}

describe("error contract", () => {
  it("raises SQLSTATE IMMUT with an IMMUTABLE_RECORD message that names the table", async () => {
    await t.db.insert(adminAuditLog).values({ action: "admin.login", entityType: "study" });
    const error = await failure(() => t.db.update(adminAuditLog).set({ action: "changed" }));
    expect(getPgError(error)).toMatchObject({
      code: "IMMUT",
      message: "IMMUTABLE_RECORD: admin_audit_log: the audit log is append-only",
    });
    expect(triggerErrorReason(error)).toBe("admin_audit_log: the audit log is append-only");
  });
});

describe("protocol_versions", () => {
  it("lets a draft change and be published", async () => {
    const study = await insertStudy(t.db);
    const consent = await insertConsentVersion(t.db, { studyId: study.id });
    const { protocol } = await insertDraftProtocol(t.db, { studyId: study.id, consentVersionId: consent.id });
    await t.db.update(protocolVersions).set({ name: "Renamed draft" }).where(eq(protocolVersions.id, protocol.id));
    const published = await publishProtocol(t.db, protocol.id);
    expect(published.status).toBe("published");
    expect(published.name).toBe("Renamed draft");
  });

  it("blocks every content change once published", async () => {
    const study = await insertStudy(t.db);
    const { protocol } = await insertPublishedProtocol(t.db, { studyId: study.id });
    const where = eq(protocolVersions.id, protocol.id);
    await expectImmutable(
      () => t.db.update(protocolVersions).set({ welcomeContent: "changed" }).where(where),
      "protocol_versions",
    );
    await expectImmutable(() => t.db.update(protocolVersions).set({ status: "draft" }).where(where));
    await expectImmutable(() => t.db.update(protocolVersions).set({ publishedAt: new Date(0) }).where(where));
    await expectImmutable(() =>
      t.db.update(protocolVersions).set({ translationsJson: { fi: { welcomeContent: "Muutettu" } } }).where(where),
    );
    // Retiring may not change anything else in the same statement.
    await expectImmutable(() =>
      t.db.update(protocolVersions).set({ status: "retired", retiredAt: new Date(), name: "x" }).where(where),
    );
    const [row] = await t.db.select().from(protocolVersions).where(where);
    expect(row).toEqual(protocol);
  });

  it("allows published to retired, then freezes the retired version", async () => {
    const study = await insertStudy(t.db);
    const { protocol } = await insertPublishedProtocol(t.db, { studyId: study.id, setAsCurrent: false });
    const where = eq(protocolVersions.id, protocol.id);
    const [retired] = await t.db
      .update(protocolVersions)
      .set({ status: "retired", retiredAt: new Date() })
      .where(where)
      .returning();
    expect(retired?.status).toBe("retired");
    await expectImmutable(() => t.db.update(protocolVersions).set({ status: "published" }).where(where));
    await expectImmutable(() => t.db.update(protocolVersions).set({ name: "x" }).where(where));
    await expectImmutable(() => t.db.delete(protocolVersions).where(where));
  });

  it("blocks deleting a published version and allows deleting a draft with its tasks", async () => {
    const study = await insertStudy(t.db);
    const published = await insertPublishedProtocol(t.db, { studyId: study.id, setAsCurrent: false });
    await expectImmutable(() => t.db.delete(protocolVersions).where(eq(protocolVersions.id, published.protocol.id)));

    const draft = await insertDraftProtocol(t.db, { studyId: study.id });
    expect(draft.tasks.length).toBeGreaterThan(0);
    expect(draft.followups.length).toBeGreaterThan(0);
    await t.db.delete(protocolVersions).where(eq(protocolVersions.id, draft.protocol.id));
    expect(await t.db.select().from(protocolTasks).where(eq(protocolTasks.protocolVersionId, draft.protocol.id))).toEqual([]);
    const firstFollowup = draft.followups[0]!;
    expect(await t.db.select().from(protocolTaskFollowups).where(eq(protocolTaskFollowups.id, firstFollowup.id))).toEqual([]);
  });

  it("refuses to publish without a published consent version or with a draft questionnaire", async () => {
    const study = await insertStudy(t.db);
    const noConsent = await insertDraftProtocol(t.db, { studyId: study.id });
    await expectInvalidState(() => publishProtocol(t.db, noConsent.protocol.id));

    const draftConsent = await insertConsentVersion(t.db, { studyId: study.id, publishedAt: null });
    const withDraftConsent = await insertDraftProtocol(t.db, { studyId: study.id, consentVersionId: draftConsent.id });
    await expectInvalidState(() => publishProtocol(t.db, withDraftConsent.protocol.id));

    const consent = await insertConsentVersion(t.db, { studyId: study.id });
    const draftQuestionnaire = await insertQuestionnaire(t.db, { studyId: study.id, status: "draft" });
    const withDraftQuestionnaire = await insertDraftProtocol(t.db, {
      studyId: study.id,
      consentVersionId: consent.id,
      backgroundQuestionnaireVersionId: draftQuestionnaire.version.id,
    });
    await expectInvalidState(() => publishProtocol(t.db, withDraftQuestionnaire.protocol.id));
  });

  it("requires published_at on a published version", async () => {
    const study = await insertStudy(t.db);
    const consent = await insertConsentVersion(t.db, { studyId: study.id });
    const { protocol } = await insertDraftProtocol(t.db, { studyId: study.id, consentVersionId: consent.id });
    await expectCheck(
      () => t.db.update(protocolVersions).set({ status: "published" }).where(eq(protocolVersions.id, protocol.id)),
      "protocol_versions_published_at_ck",
    );
  });
});

describe("protocol_tasks and protocol_task_followups", () => {
  it("can be inserted, updated and deleted while the protocol is a draft", async () => {
    const study = await insertStudy(t.db);
    const { tasks, followups } = await insertDraftProtocol(t.db, { studyId: study.id });
    const task = tasks[1]!;
    const followup = followups[0]!;
    await t.db.update(protocolTasks).set({ title: "Changed" }).where(eq(protocolTasks.id, task.id));
    await t.db.update(protocolTaskFollowups).set({ promptText: "Changed" }).where(eq(protocolTaskFollowups.id, followup.id));
    await t.db.delete(protocolTaskFollowups).where(eq(protocolTaskFollowups.id, followup.id));
    await t.db.delete(protocolTasks).where(eq(protocolTasks.id, task.id));
    expect(await t.db.select().from(protocolTasks).where(eq(protocolTasks.id, task.id))).toEqual([]);
  });

  it("blocks INSERT, UPDATE and DELETE when the protocol is published", async () => {
    const study = await insertStudy(t.db);
    const { protocol, tasks, followups } = await insertPublishedProtocol(t.db, { studyId: study.id });
    const task = tasks[1]!;
    const followup = followups[0]!;
    await expectImmutable(
      () =>
        t.db.insert(protocolTasks).values({
          protocolVersionId: protocol.id,
          taskKey: "late",
          taskType: "controlled",
          title: "Late",
          participantPrompt: "Late",
          blockKey: "controlled",
          orderIndex: 9,
        }),
      "protocol_tasks",
    );
    await expectImmutable(() => t.db.update(protocolTasks).set({ participantPrompt: "x" }).where(eq(protocolTasks.id, task.id)));
    await expectImmutable(() =>
      t.db
        .update(protocolTasks)
        .set({ translationsJson: { fi: { participantPrompt: "x" } } })
        .where(eq(protocolTasks.id, task.id)),
    );
    await expectImmutable(() =>
      t.db
        .update(protocolTaskFollowups)
        .set({ translationsJson: { fi: { promptText: "x" } } })
        .where(eq(protocolTaskFollowups.id, followup.id)),
    );
    await expectImmutable(() => t.db.delete(protocolTasks).where(eq(protocolTasks.id, task.id)));
    await expectImmutable(
      () => t.db.insert(protocolTaskFollowups).values({ protocolTaskId: task.id, followupKey: "late", promptText: "Late", orderIndex: 9 }),
      "protocol_task_followups",
    );
    await expectImmutable(() => t.db.update(protocolTaskFollowups).set({ promptText: "x" }).where(eq(protocolTaskFollowups.id, followup.id)));
    await expectImmutable(() => t.db.delete(protocolTaskFollowups).where(eq(protocolTaskFollowups.id, followup.id)));
  });

  it("blocks moving a draft task into a published protocol", async () => {
    const study = await insertStudy(t.db);
    const published = await insertPublishedProtocol(t.db, { studyId: study.id });
    const draft = await insertDraftProtocol(t.db, { studyId: study.id, tasks: [{ taskKey: "movable" }] });
    await expectImmutable(() =>
      t.db.update(protocolTasks).set({ protocolVersionId: published.protocol.id }).where(eq(protocolTasks.id, draft.tasks[0]!.id)),
    );
  });
});

describe("consent_versions", () => {
  it("lets a draft change and be deleted", async () => {
    const study = await insertStudy(t.db);
    const draft = await insertConsentVersion(t.db, { studyId: study.id, publishedAt: null });
    await t.db.update(consentVersions).set({ title: "Changed" }).where(eq(consentVersions.id, draft.id));
    await t.db.delete(consentVersions).where(eq(consentVersions.id, draft.id));
    const other = await insertConsentVersion(t.db, { studyId: study.id, publishedAt: null });
    const [published] = await t.db.update(consentVersions).set({ publishedAt: new Date() }).where(eq(consentVersions.id, other.id)).returning();
    expect(published?.publishedAt).not.toBeNull();
  });

  it("is immutable and not deletable once published", async () => {
    const study = await insertStudy(t.db);
    const consent = await insertConsentVersion(t.db, { studyId: study.id });
    const where = eq(consentVersions.id, consent.id);
    await expectImmutable(() => t.db.update(consentVersions).set({ informationText: "x" }).where(where), "consent_versions");
    await expectImmutable(() => t.db.update(consentVersions).set({ itemsJson: [] }).where(where));
    await expectImmutable(() => t.db.update(consentVersions).set({ translationsJson: { fi: { title: "Muutettu" } } }).where(where));
    await expectImmutable(() => t.db.update(consentVersions).set({ publishedAt: null }).where(where));
    await expectImmutable(() => t.db.delete(consentVersions).where(where));
  });
});

describe("questionnaire_versions and questionnaire_items", () => {
  it("lets a draft and its items change, be published, then retired", async () => {
    const study = await insertStudy(t.db);
    const { version, items } = await insertQuestionnaire(t.db, { studyId: study.id, status: "draft" });
    const where = eq(questionnaireVersions.id, version.id);
    await t.db.update(questionnaireVersions).set({ name: "Changed" }).where(where);
    await t.db.update(questionnaireItems).set({ prompt: "Changed" }).where(eq(questionnaireItems.id, items[0]!.id));
    await t.db.delete(questionnaireItems).where(eq(questionnaireItems.id, items[1]!.id));
    await t.db.update(questionnaireVersions).set({ status: "published", publishedAt: new Date() }).where(where);
    const [retired] = await t.db.update(questionnaireVersions).set({ status: "retired", retiredAt: new Date() }).where(where).returning();
    expect(retired?.status).toBe("retired");
    await expectImmutable(() => t.db.update(questionnaireVersions).set({ status: "published" }).where(where));
  });

  it("blocks changes to a published version and its items", async () => {
    const study = await insertStudy(t.db);
    const { version, items } = await insertQuestionnaire(t.db, { studyId: study.id });
    const where = eq(questionnaireVersions.id, version.id);
    await expectImmutable(() => t.db.update(questionnaireVersions).set({ name: "x" }).where(where), "questionnaire_versions");
    await expectImmutable(() => t.db.update(questionnaireVersions).set({ translationsJson: { fi: { name: "x" } } }).where(where));
    await expectImmutable(() =>
      t.db
        .update(questionnaireItems)
        .set({ translationsJson: { fi: { prompt: "x" } } })
        .where(eq(questionnaireItems.id, items[0]!.id)),
    );
    await expectImmutable(() => t.db.update(questionnaireVersions).set({ status: "draft" }).where(where));
    await expectImmutable(() => t.db.delete(questionnaireVersions).where(where));
    await expectImmutable(
      () => t.db.update(questionnaireItems).set({ prompt: "x" }).where(eq(questionnaireItems.id, items[0]!.id)),
      "questionnaire_items",
    );
    await expectImmutable(() => t.db.delete(questionnaireItems).where(eq(questionnaireItems.id, items[0]!.id)));
    await expectImmutable(() =>
      t.db.insert(questionnaireItems).values({ questionnaireVersionId: version.id, itemKey: "late", type: "free_text", prompt: "Late", orderIndex: 9 }),
    );
  });

  it("allows deleting a draft together with its items", async () => {
    const study = await insertStudy(t.db);
    const { version } = await insertQuestionnaire(t.db, { studyId: study.id, status: "draft" });
    await t.db.delete(questionnaireVersions).where(eq(questionnaireVersions.id, version.id));
    expect(await t.db.select().from(questionnaireItems).where(eq(questionnaireItems.questionnaireVersionId, version.id))).toEqual([]);
  });
});

describe("ai_prompt_versions and model_configs", () => {
  it("lets drafts change and be deleted", async () => {
    const study = await insertStudy(t.db);
    const [prompt] = await t.db
      .insert(aiPromptVersions)
      .values({ studyId: study.id, key: "k", stage: "translation", versionNumber: 1, name: "Draft", promptText: "a" })
      .returning();
    await t.db.update(aiPromptVersions).set({ promptText: "b" }).where(eq(aiPromptVersions.id, prompt!.id));
    const [config] = await t.db
      .insert(modelConfigs)
      .values({ studyId: study.id, key: "k", stage: "translation", versionNumber: 1, provider: "mock", modelId: "m1", promptVersionId: prompt!.id })
      .returning();
    await t.db.update(modelConfigs).set({ modelId: "m2" }).where(eq(modelConfigs.id, config!.id));
    await t.db.delete(modelConfigs).where(eq(modelConfigs.id, config!.id));
    await t.db.delete(aiPromptVersions).where(eq(aiPromptVersions.id, prompt!.id));
  });

  it("freezes content once active, while status, activated_at and retired_at may change", async () => {
    const study = await insertStudy(t.db);
    const { prompts, configs } = await insertActiveAiConfigs(t.db, { studyId: study.id });
    const promptWhere = eq(aiPromptVersions.id, prompts.translationDefault.id);
    const configWhere = eq(modelConfigs.id, configs.translationDefault.id);

    await expectImmutable(() => t.db.update(aiPromptVersions).set({ promptText: "x" }).where(promptWhere), "ai_prompt_versions");
    await expectImmutable(() => t.db.update(aiPromptVersions).set({ conditionKey: "x" }).where(promptWhere));
    await expectImmutable(() => t.db.update(aiPromptVersions).set({ status: "draft" }).where(promptWhere));
    await expectImmutable(() => t.db.delete(aiPromptVersions).where(eq(aiPromptVersions.id, prompts.asrContext.id)));
    await expectImmutable(() => t.db.update(modelConfigs).set({ modelId: "x" }).where(configWhere), "model_configs");
    await expectImmutable(() => t.db.update(modelConfigs).set({ parametersJson: { temperature: 1 } }).where(configWhere));
    await expectImmutable(() => t.db.update(modelConfigs).set({ promptVersionId: null }).where(configWhere));
    await expectImmutable(() => t.db.update(modelConfigs).set({ status: "draft" }).where(configWhere));
    await expectImmutable(() => t.db.delete(modelConfigs).where(configWhere));

    const [retiredPrompt] = await t.db.update(aiPromptVersions).set({ status: "retired", retiredAt: new Date() }).where(promptWhere).returning();
    expect(retiredPrompt?.status).toBe("retired");
    const [retiredConfig] = await t.db.update(modelConfigs).set({ status: "retired", retiredAt: new Date() }).where(configWhere).returning();
    expect(retiredConfig?.status).toBe("retired");
    const [reactivated] = await t.db.update(modelConfigs).set({ status: "active", activatedAt: new Date(), retiredAt: null }).where(configWhere).returning();
    expect(reactivated?.status).toBe("active");
    await expectImmutable(() => t.db.delete(modelConfigs).where(configWhere));
  });

  it("refuses to activate a model config whose prompt is still a draft", async () => {
    const study = await insertStudy(t.db);
    const [prompt] = await t.db
      .insert(aiPromptVersions)
      .values({ studyId: study.id, key: "k", stage: "translation", versionNumber: 1, name: "Draft", promptText: "a" })
      .returning();
    const [config] = await t.db
      .insert(modelConfigs)
      .values({ studyId: study.id, key: "k", stage: "translation", versionNumber: 1, provider: "mock", modelId: "m", promptVersionId: prompt!.id })
      .returning();
    await expectInvalidState(() =>
      t.db.update(modelConfigs).set({ status: "active", activatedAt: new Date() }).where(eq(modelConfigs.id, config!.id)),
    );
    await t.db.update(aiPromptVersions).set({ status: "active", activatedAt: new Date() }).where(eq(aiPromptVersions.id, prompt!.id));
    await t.db.update(modelConfigs).set({ status: "active", activatedAt: new Date() }).where(eq(modelConfigs.id, config!.id));
  });

  it("allows only one active prompt and one active config per key", async () => {
    const study = await insertStudy(t.db);
    await insertActiveAiConfigs(t.db, { studyId: study.id });
    await expectUnique(
      () =>
        t.db.insert(aiPromptVersions).values({
          studyId: study.id, key: "translation_default", stage: "translation", versionNumber: 2, status: "active", name: "v2", promptText: "v2",
        }),
      "ai_prompt_versions_one_active_uq",
    );
    await expectUnique(
      () =>
        t.db.insert(modelConfigs).values({
          studyId: study.id, key: "translation_default", stage: "translation", versionNumber: 2, status: "active", provider: "mock", modelId: "m",
        }),
      "model_configs_one_active_uq",
    );
    // A second version as a draft is fine.
    await t.db.insert(aiPromptVersions).values({
      studyId: study.id, key: "translation_default", stage: "translation", versionNumber: 2, name: "v2", promptText: "v2",
    });
  });
});

describe("transcripts and transcript_revisions", () => {
  it("keeps revision content immutable while verification fields and is_current may change", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    const { revision } = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id });
    const where = eq(transcriptRevisions.id, revision.id);
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ text: "changed" }).where(where), "transcript_revisions");
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ revisionNumber: 7 }).where(where));
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ createdByLabel: "someone else" }).where(where));
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ changeReason: "x" }).where(where));
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ segmentsJson: [] }).where(where));
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ transcriptionConventionVersion: "9" }).where(where));
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ createdAt: new Date(0) }).where(where));

    const [verified] = await t.db
      .update(transcriptRevisions)
      .set({ verifiedAt: new Date(), verifiedByLabel: "researcher", verificationNotes: "checked", isCurrent: false })
      .where(where)
      .returning();
    expect(verified?.text).toBe(revision.text);
    expect(verified?.verifiedByLabel).toBe("researcher");
    expect(verified?.isCurrent).toBe(false);
  });

  it("never deletes a revision", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    const { revision } = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id });
    await expectImmutable(() => t.db.delete(transcriptRevisions).where(eq(transcriptRevisions.id, revision.id)));
  });

  it("allows one current revision per transcript", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    const { transcript } = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id });
    await expectUnique(
      () =>
        t.db.insert(transcriptRevisions).values({
          transcriptId: transcript.id, revisionNumber: 2, text: "second", createdByType: "researcher", isCurrent: true,
        }),
      "transcript_revisions_one_current_uq",
    );
    // The builder switches the earlier revision off first, which is the correct sequence.
    const second = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id, text: "second" });
    expect(second.revision.revisionNumber).toBe(2);
    const rows = await t.db.select().from(transcriptRevisions).where(eq(transcriptRevisions.transcriptId, transcript.id));
    expect(rows.filter((row) => row.isCurrent).map((row) => row.revisionNumber)).toEqual([2]);
    await expectUnique(
      () => t.db.insert(transcriptRevisions).values({ transcriptId: transcript.id, revisionNumber: 2, text: "dup", createdByType: "researcher", isCurrent: false }),
      "transcript_revisions_transcript_number_uq",
    );
  });

  it("allows one transcript per utterance and type", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    await t.db.insert(transcripts).values({ utteranceId: utterance.id, type: "asr" });
    await t.db.insert(transcripts).values({ utteranceId: utterance.id, type: "human_dialect" });
    await expectUnique(
      () => t.db.insert(transcripts).values({ utteranceId: utterance.id, type: "asr" }),
      "transcripts_utterance_type_uq",
    );
  });
});

describe("model_runs", () => {
  it("can be completed while running, then is immutable and never deletable", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    const run = await insertModelRun(t.db, { stage: "asr", sourceEntityType: "utterance", sourceEntityId: utterance.id });
    const where = eq(modelRuns.id, run.id);
    const [finished] = await t.db
      .update(modelRuns)
      .set({ status: "succeeded", finishedAt: new Date(), latencyMs: 12, returnedModel: "mock-asr-1" })
      .where(where)
      .returning();
    expect(finished?.status).toBe("succeeded");
    await expectImmutable(() => t.db.update(modelRuns).set({ returnedModel: "other" }).where(where), "model_runs");
    await expectImmutable(() => t.db.update(modelRuns).set({ status: "running" }).where(where));
    await expectImmutable(() => t.db.delete(modelRuns).where(where));

    const failed = await insertModelRun(t.db, { sourceEntityType: "utterance", sourceEntityId: utterance.id, status: "failed", errorCode: "X" });
    await expectImmutable(() => t.db.update(modelRuns).set({ errorMessage: "rewritten" }).where(eq(modelRuns.id, failed.id)));
    const running = await insertModelRun(t.db, { sourceEntityType: "utterance", sourceEntityId: utterance.id });
    await expectImmutable(() => t.db.delete(modelRuns).where(eq(modelRuns.id, running.id)));
  });

  it("enforces a unique idempotency key", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    await insertModelRun(t.db, { sourceEntityType: "utterance", sourceEntityId: utterance.id, idempotencyKey: "same-run-key" });
    await expectUnique(
      () => insertModelRun(t.db, { sourceEntityType: "utterance", sourceEntityId: utterance.id, idempotencyKey: "same-run-key" }),
      "model_runs_idempotency_key_unique",
    );
  });
});

describe("jobs", () => {
  it("enforces a unique idempotency key", async () => {
    await t.db.insert(jobs).values({ type: "asr", payloadJson: {}, idempotencyKey: "same-job-key" });
    await expectUnique(
      () => t.db.insert(jobs).values({ type: "asr", payloadJson: {}, idempotencyKey: "same-job-key" }),
      "jobs_idempotency_key_unique",
    );
  });
});

describe("translations and syntheses", () => {
  it("only lets status change and never deletes", async () => {
    const lineage = await insertLineage("research");
    const translationWhere = eq(translations.id, lineage.translation.id);
    const synthesisWhere = eq(syntheses.id, lineage.synthesis.id);

    await expectImmutable(() => t.db.update(translations).set({ translatedText: "x" }).where(translationWhere), "translations");
    await expectImmutable(() => t.db.update(translations).set({ conditionKey: "x" }).where(translationWhere));
    await expectImmutable(() => t.db.delete(translations).where(translationWhere));
    const [reviewed] = await t.db.update(translations).set({ status: "reviewed" }).where(translationWhere).returning();
    expect(reviewed?.status).toBe("reviewed");

    await expectImmutable(() => t.db.update(syntheses).set({ sourceText: "x" }).where(synthesisWhere), "syntheses");
    await expectImmutable(() => t.db.update(syntheses).set({ voiceKey: "x" }).where(synthesisWhere));
    await expectImmutable(() => t.db.delete(syntheses).where(synthesisWhere));
    const [excluded] = await t.db.update(syntheses).set({ status: "excluded" }).where(synthesisWhere).returning();
    expect(excluded?.status).toBe("excluded");
  });

  it("enforces translation identity: one per revision, condition, batch and repetition", async () => {
    const lineage = await insertLineage("research");
    await expectUnique(
      () => insertTranslation(t.db, { sourceTranscriptRevisionId: lineage.revision.id, processingBatchId: lineage.batch.id }),
      "translations_identity_uq",
    );
    // Another condition, an explicit repetition and another batch are all separate outputs.
    await insertTranslation(t.db, { sourceTranscriptRevisionId: lineage.revision.id, processingBatchId: lineage.batch.id, conditionKey: "preservation" });
    await insertTranslation(t.db, { sourceTranscriptRevisionId: lineage.revision.id, processingBatchId: lineage.batch.id, repetitionIndex: 1 });
    const otherBatch = await insertProcessingBatch(t.db, { studyId: lineage.study.id });
    await insertTranslation(t.db, { sourceTranscriptRevisionId: lineage.revision.id, processingBatchId: otherBatch.id });
    // One model run produces at most one translation.
    await expectUnique(
      () =>
        t.db.insert(translations).values({
          sourceTranscriptRevisionId: lineage.revision.id, conditionKey: "third", processingBatchId: lineage.batch.id,
          modelRunId: lineage.translationRun.id, translatedText: "again",
        }),
      "translations_model_run_uq",
    );
  });
});

describe("media_assets", () => {
  it("keeps identity and content columns immutable, lets deleted_at and metadata_json change", async () => {
    const { media } = await insertSessionWithUtterance(t.db);
    const where = eq(mediaAssets.id, media.id);
    await expectImmutable(() => t.db.update(mediaAssets).set({ storageKey: "other/key.wav" }).where(where), "media_assets");
    await expectImmutable(() => t.db.update(mediaAssets).set({ sha256: randomSha256() }).where(where));
    await expectImmutable(() => t.db.update(mediaAssets).set({ sizeBytes: 1 }).where(where));
    await expectImmutable(() => t.db.update(mediaAssets).set({ kind: "other" }).where(where));
    await expectImmutable(() => t.db.update(mediaAssets).set({ utteranceId: null }).where(where));
    await expectImmutable(() => t.db.update(mediaAssets).set({ sessionId: null }).where(where));
    await expectImmutable(() => t.db.update(mediaAssets).set({ sampleRateHz: 16000 }).where(where));
    await expectImmutable(() => t.db.update(mediaAssets).set({ durationMs: 1 }).where(where));
    await expectImmutable(() => t.db.update(mediaAssets).set({ createdAt: new Date(0) }).where(where));

    const [updated] = await t.db
      .update(mediaAssets)
      .set({ deletedAt: new Date(), metadataJson: { deletion: { reason: "participant request" } } })
      .where(where)
      .returning();
    expect(updated?.deletedAt).not.toBeNull();
    await expectImmutable(() => t.db.update(mediaAssets).set({ deletedAt: null }).where(where));
  });

  it("lets a candidate of an open utterance be removed, while the accepted asset is protected", async () => {
    const { study, session, tasks, media } = await insertSessionWithUtterance(t.db);
    const presentation = await insertTaskPresentation(t.db, { sessionId: session.id, protocolTaskId: tasks[1]!.id });
    const [open] = await t.db
      .insert(utterances)
      .values({ sessionId: session.id, taskPresentationId: presentation.id, promptSnapshot: "p", turnIndex: 0, status: "uploading" })
      .returning();
    const rejected = await insertMediaAsset(t.db, { studyId: study.id, sessionId: session.id, utteranceId: open!.id });
    await t.db.delete(mediaAssets).where(eq(mediaAssets.id, rejected.id));
    expect(await t.db.select().from(mediaAssets).where(eq(mediaAssets.id, rejected.id))).toEqual([]);
    // The accepted recording of a submitted research utterance (migration 0003, see hardening.test.ts).
    await expectImmutable(() => t.db.delete(mediaAssets).where(eq(mediaAssets.id, media.id)), "media_assets");
  });

  it("checks sha256 format and non-negative sizes", async () => {
    const study = await insertStudy(t.db);
    await expectCheck(() => insertMediaAsset(t.db, { studyId: study.id, sha256: "abc" }), "media_assets_sha256_ck");
    await expectCheck(() => insertMediaAsset(t.db, { studyId: study.id, sha256: randomSha256().toUpperCase() }), "media_assets_sha256_ck");
    await expectCheck(() => insertMediaAsset(t.db, { studyId: study.id, sizeBytes: -1 }), "media_assets_size_bytes_ck");
    await expectCheck(() => insertMediaAsset(t.db, { studyId: study.id, durationMs: -1 }), "media_assets_duration_ms_ck");
  });
});

describe("utterances", () => {
  it("can change freely before submission", async () => {
    const { study, session, tasks } = await insertSessionWithUtterance(t.db);
    const presentation = await insertTaskPresentation(t.db, { sessionId: session.id, protocolTaskId: tasks[1]!.id });
    const [utterance] = await t.db
      .insert(utterances)
      .values({ sessionId: session.id, taskPresentationId: presentation.id, promptSnapshot: "p", turnIndex: 0 })
      .returning();
    const first = await insertMediaAsset(t.db, { studyId: study.id, sessionId: session.id, utteranceId: utterance!.id });
    const second = await insertMediaAsset(t.db, { studyId: study.id, sessionId: session.id, utteranceId: utterance!.id });
    const where = eq(utterances.id, utterance!.id);
    await t.db.update(utterances).set({ status: "uploading", acceptedMediaAssetId: first.id }).where(where);
    await t.db.update(utterances).set({ acceptedMediaAssetId: second.id, attemptCount: 2 }).where(where);
    const [submitted] = await t.db.update(utterances).set({ status: "submitted", submittedAt: new Date() }).where(where).returning();
    expect(submitted?.acceptedMediaAssetId).toBe(second.id);
  });

  it("freezes the recording link and prompt once submitted", async () => {
    const { study, session, utterance } = await insertSessionWithUtterance(t.db);
    const other = await insertMediaAsset(t.db, { studyId: study.id, sessionId: session.id, utteranceId: utterance.id });
    const where = eq(utterances.id, utterance.id);
    await expectImmutable(() => t.db.update(utterances).set({ acceptedMediaAssetId: other.id }).where(where), "utterances");
    await expectImmutable(() => t.db.update(utterances).set({ promptSnapshot: "x" }).where(where));
    await expectImmutable(() => t.db.update(utterances).set({ turnIndex: 5 }).where(where));
    await expectImmutable(() => t.db.update(utterances).set({ submittedAt: new Date(0) }).where(where));
    await expectImmutable(() => t.db.update(utterances).set({ status: "recording" }).where(where));

    const [excluded] = await t.db
      .update(utterances)
      .set({ status: "excluded", exclusionReason: "background noise", flagged: true, flagNotes: "check", qualityJson: { silenceRatio: 0.9 } })
      .where(where)
      .returning();
    expect(excluded?.status).toBe("excluded");
    await expectImmutable(() => t.db.update(utterances).set({ acceptedMediaAssetId: other.id }).where(where));
    await expectImmutable(() => t.db.update(utterances).set({ status: "invalid" }).where(where));
    const [included] = await t.db.update(utterances).set({ status: "submitted", exclusionReason: null }).where(where).returning();
    expect(included?.status).toBe("submitted");
  });

  it("requires an accepted recording for a submitted utterance and attempt_count of at least 1", async () => {
    const { session, tasks } = await insertSessionWithUtterance(t.db);
    const presentation = await insertTaskPresentation(t.db, { sessionId: session.id, protocolTaskId: tasks[1]!.id });
    const base = { sessionId: session.id, taskPresentationId: presentation.id, promptSnapshot: "p", turnIndex: 0 };
    await expectCheck(
      () => t.db.insert(utterances).values({ ...base, status: "submitted", submittedAt: new Date() }),
      "utterances_submitted_has_media_ck",
    );
    await expectCheck(() => t.db.insert(utterances).values({ ...base, attemptCount: 0 }), "utterances_attempt_count_ck");
    await expectCheck(() => t.db.insert(utterances).values({ ...base, durationMs: -5 }), "utterances_duration_ms_ck");
  });
});

describe("task_presentations", () => {
  it("keeps what the participant saw immutable, lets progress fields change", async () => {
    const { presentation, tasks, session } = await insertSessionWithUtterance(t.db);
    const where = eq(taskPresentations.id, presentation.id);
    await expectImmutable(() => t.db.update(taskPresentations).set({ promptSnapshot: "x" }).where(where), "task_presentations");
    await expectImmutable(() => t.db.update(taskPresentations).set({ titleSnapshot: "x" }).where(where));
    await expectImmutable(() => t.db.update(taskPresentations).set({ contextSnapshot: "x" }).where(where));
    await expectImmutable(() => t.db.update(taskPresentations).set({ instructionsSnapshot: "x" }).where(where));
    await expectImmutable(() => t.db.update(taskPresentations).set({ snapshotLocale: "en" }).where(where));
    await expectImmutable(() => t.db.update(taskPresentations).set({ sequenceIndex: 4 }).where(where));
    await expectImmutable(() => t.db.update(taskPresentations).set({ protocolTaskId: tasks[1]!.id }).where(where));
    const other = await insertSessionWithUtterance(t.db);
    await expectImmutable(() => t.db.update(taskPresentations).set({ sessionId: other.session.id }).where(where));
    const [completed] = await t.db.update(taskPresentations).set({ status: "completed", completedAt: new Date() }).where(where).returning();
    expect(completed?.status).toBe("completed");
    expect(completed?.sessionId).toBe(session.id);
  });
});

describe("session_consents", () => {
  it("cannot be updated or deleted", async () => {
    const { sessionConsent } = await insertSessionWithUtterance(t.db);
    const where = eq(sessionConsents.id, sessionConsent.id);
    await expectImmutable(() => t.db.update(sessionConsents).set({ responsesJson: [] }).where(where), "session_consents");
    await expectImmutable(() => t.db.update(sessionConsents).set({ acceptedAt: new Date(0) }).where(where));
    await expectImmutable(() => t.db.delete(sessionConsents).where(where));
    expect(await t.db.select().from(sessionConsents).where(where)).toEqual([sessionConsent]);
  });
});

describe("sessions", () => {
  it("keeps protocol version, mode, study and participant code immutable", async () => {
    const { session, study } = await insertSessionWithUtterance(t.db);
    const otherStudy = await insertStudy(t.db);
    const otherProtocol = await insertPublishedProtocol(t.db, { studyId: study.id, setAsCurrent: false });
    const where = eq(sessions.id, session.id);
    await expectImmutable(() => t.db.update(sessions).set({ protocolVersionId: otherProtocol.protocol.id }).where(where), "sessions");
    await expectImmutable(() => t.db.update(sessions).set({ mode: "test" }).where(where));
    await expectImmutable(() => t.db.update(sessions).set({ studyId: otherStudy.id }).where(where));
    await expectImmutable(() => t.db.update(sessions).set({ participantCode: "P-CHANGED1" }).where(where));
    const [completed] = await t.db
      .update(sessions)
      .set({ status: "completed", completedAt: new Date(), flagged: true, excluded: true, exclusionReason: "pilot" })
      .where(where)
      .returning();
    expect(completed?.status).toBe("completed");
  });
});

describe("processing_batches", () => {
  it("lets a draft change and be deleted", async () => {
    const study = await insertStudy(t.db);
    const batch = await insertProcessingBatch(t.db, { studyId: study.id });
    const where = eq(processingBatches.id, batch.id);
    await t.db.update(processingBatches).set({ configurationSnapshotJson: emptyBatchSnapshot({ runAsr: true }), name: "renamed" }).where(where);
    await t.db.delete(processingBatches).where(where);
    expect(await t.db.select().from(processingBatches).where(where)).toEqual([]);
  });

  it("freezes the configuration once started and cannot be deleted", async () => {
    const study = await insertStudy(t.db);
    const otherStudy = await insertStudy(t.db);
    const batch = await insertProcessingBatch(t.db, { studyId: study.id });
    const where = eq(processingBatches.id, batch.id);
    await t.db.update(processingBatches).set({ status: "queued" }).where(where);
    await expectImmutable(
      () => t.db.update(processingBatches).set({ configurationSnapshotJson: emptyBatchSnapshot({ runAsr: true }) }).where(where),
      "processing_batches",
    );
    await expectImmutable(() => t.db.update(processingBatches).set({ dataMode: "test" }).where(where));
    await expectImmutable(() => t.db.update(processingBatches).set({ studyId: otherStudy.id }).where(where));
    await expectImmutable(() => t.db.update(processingBatches).set({ status: "draft" }).where(where));
    await expectImmutable(() => t.db.delete(processingBatches).where(where));
    const [cancelled] = await t.db
      .update(processingBatches)
      .set({ status: "cancelled", cancelledAt: new Date(), startedAt: new Date() })
      .where(where)
      .returning();
    expect(cancelled?.status).toBe("cancelled");
    await expectImmutable(() => t.db.delete(processingBatches).where(where));
  });
});

describe("admin_audit_log", () => {
  it("is append-only, even with the reset setting", async () => {
    const [row] = await t.db.insert(adminAuditLog).values({ action: "test_data.reset", entityType: "study" }).returning();
    const where = eq(adminAuditLog.id, row!.id);
    await expectImmutable(() => t.db.update(adminAuditLog).set({ actorLabel: "x" }).where(where), "admin_audit_log");
    await expectImmutable(() => t.db.delete(adminAuditLog).where(where));
    await expectImmutable(() =>
      t.db.transaction(async (tx) => {
        await allowTestDataReset(tx);
        await tx.delete(adminAuditLog).where(where);
      }),
    );
    expect(await t.db.select().from(adminAuditLog).where(where)).toHaveLength(1);
  });
});

describe("set_updated_at", () => {
  it("has a trigger on every table with an updated_at column", async () => {
    const result = await t.db.execute<{ table_name: string; has_trigger: boolean }>(sql`
      SELECT c.table_name,
             EXISTS (
               SELECT 1 FROM pg_trigger g
               JOIN pg_class r ON r.oid = g.tgrelid
               WHERE r.relname = c.table_name AND g.tgname = 'dialect_90_set_updated_at'
             ) AS has_trigger
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
      ORDER BY c.table_name`);
    expect(result.rows.map((row) => row.table_name)).toEqual(
      ["jobs", "protocol_versions", "sessions", "studies", "transcripts", "utterances"],
    );
    expect(result.rows.every((row) => row.has_trigger)).toBe(true);
  });

  it("moves updated_at forward on a real change and leaves it on a no-op update", async () => {
    const past = new Date("2020-01-01T00:00:00Z");
    const study = await insertStudy(t.db, { updatedAt: past });
    await t.db.update(studies).set({ name: study.name }).where(eq(studies.id, study.id));
    const [unchanged] = await t.db.select().from(studies).where(eq(studies.id, study.id));
    expect(unchanged?.updatedAt).toEqual(past);
    const [changed] = await t.db.update(studies).set({ name: "Renamed" }).where(eq(studies.id, study.id)).returning();
    expect(changed!.updatedAt.getTime()).toBeGreaterThan(past.getTime());
  });
});

describe("test and demo data reset", () => {
  it("requires the transaction setting", async () => {
    const lineage = await insertLineage("test");
    await expectImmutable(() => t.db.delete(syntheses).where(eq(syntheses.id, lineage.synthesis.id)));
    await expectImmutable(() => t.db.delete(translations).where(eq(translations.id, lineage.translation.id)));
    await expectImmutable(() => t.db.delete(transcriptRevisions).where(eq(transcriptRevisions.id, lineage.revision.id)));
    await expectImmutable(() => t.db.delete(modelRuns).where(eq(modelRuns.id, lineage.translationRun.id)));
    await expectImmutable(() => t.db.delete(sessionConsents).where(eq(sessionConsents.id, lineage.sessionConsent.id)));
    await expectImmutable(() => t.db.delete(processingBatches).where(eq(processingBatches.id, lineage.batch.id)));
  });

  it("never deletes research rows, even with the setting", async () => {
    const lineage = await insertLineage("research");
    const attempt = (action: (tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0]) => Promise<unknown>) =>
      expectImmutable(() =>
        t.db.transaction(async (tx) => {
          await allowTestDataReset(tx);
          await action(tx);
        }),
      );
    await attempt((tx) => tx.delete(syntheses).where(eq(syntheses.id, lineage.synthesis.id)));
    await attempt((tx) => tx.delete(translations).where(eq(translations.id, lineage.translation.id)));
    await attempt((tx) => tx.delete(transcriptRevisions).where(eq(transcriptRevisions.id, lineage.revision.id)));
    await attempt((tx) => tx.delete(modelRuns).where(eq(modelRuns.id, lineage.translationRun.id)));
    await attempt((tx) => tx.delete(sessionConsents).where(eq(sessionConsents.id, lineage.sessionConsent.id)));
    await attempt((tx) => tx.delete(processingBatches).where(eq(processingBatches.id, lineage.batch.id)));

    // A model run without a batch is recognized through its source entity.
    const asrRun = await insertModelRun(t.db, { stage: "asr", sourceEntityType: "utterance", sourceEntityId: lineage.utterance.id });
    await attempt((tx) => tx.delete(modelRuns).where(eq(modelRuns.id, asrRun.id)));
    // A test batch cannot hold an output of a research transcript at all (migration 0003).
    const testBatch = await insertProcessingBatch(t.db, { studyId: lineage.study.id, dataMode: "test", status: "completed" });
    await expectInvalidState(() =>
      insertTranslation(t.db, { sourceTranscriptRevisionId: lineage.revision.id, processingBatchId: testBatch.id }),
    );
  });

  it("does not leak the setting into later transactions", async () => {
    const lineage = await insertLineage("test");
    await t.db.transaction(async (tx) => {
      await allowTestDataReset(tx);
    });
    for (let i = 0; i < 6; i += 1) {
      await expectImmutable(() => t.db.delete(translations).where(eq(translations.id, lineage.translation.id)));
    }
  });

  it("deleteDemoAndTestData removes demo and test data of a study and keeps research data", async () => {
    const research = await insertLineage("research");
    const studyId = research.study.id;
    const protocolVersionId = research.protocol.id;
    const buildIn = async (mode: "demo" | "test") => {
      const collected = await insertSessionWithUtterance(t.db, { studyId, protocolVersionId, session: { mode } });
      const asr = await insertTranscriptWithRevision(t.db, { utteranceId: collected.utterance.id, type: "asr" });
      const first = await insertTranscriptWithRevision(t.db, { utteranceId: collected.utterance.id });
      // A second revision derived from the first (self reference inside the table).
      const second = await insertTranscriptWithRevision(t.db, {
        utteranceId: collected.utterance.id,
        text: "second",
        revision: { derivedFromRevisionId: first.revision.id },
      });
      const batch = await insertProcessingBatch(t.db, { studyId, dataMode: mode, status: "completed" });
      const { translation } = await insertTranslation(t.db, { sourceTranscriptRevisionId: second.revision.id, processingBatchId: batch.id });
      const { ttsMedia } = { ttsMedia: (await insertSynthesis(t.db, { studyId, translationId: translation.id, processingBatchId: batch.id })).media };
      // An ASR run outside any batch, a derived media file, a job and a flag.
      await insertModelRun(t.db, { stage: "asr", sourceEntityType: "utterance", sourceEntityId: collected.utterance.id, status: "succeeded" });
      const derived = await insertMediaAsset(t.db, {
        studyId, sessionId: collected.session.id, utteranceId: collected.utterance.id,
        kind: "source_audio_derived", derivedFromMediaAssetId: collected.media.id,
      });
      await t.db.insert(jobs).values({ type: "translation", payloadJson: {}, processingBatchId: batch.id, idempotencyKey: `job-${batch.id}` });
      await t.db.insert(researchFlags).values({ entityType: "utterance", entityId: collected.utterance.id, reasonCode: "poor_audio" });
      return { ...collected, asr, batch, translation, ttsMedia, derived };
    };
    const test = await buildIn("test");
    const demo = await buildIn("demo");
    await t.db.insert(researchFlags).values({ entityType: "utterance", entityId: research.utterance.id, reasonCode: "other" });

    // Only test data first.
    const testOnly = await t.db.transaction((tx) => deleteDemoAndTestData(tx, { studyId, modes: ["test"] }));
    expect(testOnly.deleted.sessions).toBe(1);
    expect(testOnly.storageObjects.map((object) => object.storageKey).sort()).toEqual(
      [test.media.storageKey, test.derived.storageKey, test.ttsMedia.storageKey].sort(),
    );
    expect(await t.db.select().from(sessions).where(eq(sessions.id, demo.session.id))).toHaveLength(1);

    const rest = await t.db.transaction((tx) => deleteDemoAndTestData(tx, { studyId }));
    expect(rest.deleted).toMatchObject({
      sessions: 1,
      utterances: 1,
      media_assets: 3,
      transcripts: 2,
      transcript_revisions: 3,
      translations: 1,
      syntheses: 1,
      model_runs: 3,
      processing_batches: 1,
      jobs: 1,
      session_consents: 1,
      task_presentations: 1,
      research_flags: 1,
    });

    const remainingSessions = await t.db.select().from(sessions).where(eq(sessions.studyId, studyId));
    expect(remainingSessions.map((row) => row.id)).toEqual([research.session.id]);
    // The research lineage is untouched.
    expect(await t.db.select().from(utterances).where(eq(utterances.id, research.utterance.id))).toHaveLength(1);
    expect(await t.db.select().from(transcriptRevisions).where(eq(transcriptRevisions.id, research.revision.id))).toHaveLength(1);
    expect(await t.db.select().from(translations).where(eq(translations.id, research.translation.id))).toHaveLength(1);
    expect(await t.db.select().from(syntheses).where(eq(syntheses.id, research.synthesis.id))).toHaveLength(1);
    expect(await t.db.select().from(mediaAssets).where(eq(mediaAssets.studyId, studyId))).toHaveLength(2);
    expect(await t.db.select().from(processingBatches).where(eq(processingBatches.studyId, studyId))).toHaveLength(1);
    expect(await t.db.select().from(researchFlags).where(eq(researchFlags.entityId, research.utterance.id))).toHaveLength(1);
    // Published definitions are not part of the reset.
    expect(await t.db.select().from(protocolVersions).where(eq(protocolVersions.id, protocolVersionId))).toHaveLength(1);

    // Nothing left to delete on a second run.
    const again = await t.db.transaction((tx) => deleteDemoAndTestData(tx, { studyId }));
    expect(again.deleted.sessions).toBe(0);
    expect(again.storageObjects).toEqual([]);
  });

  // Defect E2E-4: jobs without a batch stayed behind after the reset, so the
  // Dashboard kept counting their failures.
  it("deleteDemoAndTestData removes queue jobs of deleted utterances and media, and no job of research data", async () => {
    const research = await insertLineage("research");
    const studyId = research.study.id;
    const protocolVersionId = research.protocol.id;
    const test = await insertSessionWithUtterance(t.db, { studyId, protocolVersionId, session: { mode: "test" } });
    const demo = await insertSessionWithUtterance(t.db, { studyId, protocolVersionId, session: { mode: "demo" } });
    const researchBatch = await insertProcessingBatch(t.db, { studyId, dataMode: "research", status: "completed" });

    const tag = randomUUID();
    const keyOf = (name: string) => `${tag}:${name}`;
    const discardedKey = (sessionId: string) => `studies/s/sessions/${sessionId}/utterances/${randomUUID()}/source/${randomUUID()}.wav`;
    const testDiscarded = discardedKey(test.session.id);
    const testDiscardedDone = discardedKey(test.session.id);
    const researchDiscarded = discardedKey(research.session.id);
    await t.db.insert(jobs).values([
      // Jobs of TEST and DEMO data, all without a batch.
      { type: "asr", status: "failed", payloadJson: { utteranceId: test.utterance.id, mediaAssetId: test.media.id, trigger: "auto_on_upload" }, idempotencyKey: keyOf("test-asr") },
      { type: "asr", status: "cancelled", payloadJson: { utteranceId: demo.utterance.id }, idempotencyKey: keyOf("demo-asr") },
      { type: "derive_wav", status: "failed", payloadJson: { mediaAssetId: test.media.id }, idempotencyKey: keyOf("test-derive") },
      { type: "derive_wav", status: "queued", payloadJson: { mediaAssetId: demo.media.id }, idempotencyKey: keyOf("demo-derive") },
      { type: "delete_storage_object", status: "failed", payloadJson: { type: "delete_storage_object", storageKey: testDiscarded }, idempotencyKey: keyOf("test-delete") },
      { type: "delete_storage_object", status: "succeeded", payloadJson: { type: "delete_storage_object", storageKey: testDiscardedDone }, idempotencyKey: keyOf("test-delete-done") },
      // Jobs of research data, and jobs that name nothing.
      { type: "asr", status: "failed", payloadJson: { utteranceId: research.utterance.id, mediaAssetId: research.media.id }, idempotencyKey: keyOf("research-asr") },
      { type: "derive_wav", status: "failed", payloadJson: { mediaAssetId: research.media.id }, idempotencyKey: keyOf("research-derive") },
      { type: "delete_storage_object", status: "failed", payloadJson: { type: "delete_storage_object", storageKey: researchDiscarded }, idempotencyKey: keyOf("research-delete") },
      { type: "translation", status: "failed", payloadJson: { utteranceId: research.utterance.id }, processingBatchId: researchBatch.id, idempotencyKey: keyOf("research-batch") },
      { type: "export", status: "failed", payloadJson: { exportJobId: randomUUID() }, idempotencyKey: keyOf("export") },
      { type: "other", status: "failed", payloadJson: {}, idempotencyKey: keyOf("empty") },
    ]);
    const remaining = async () =>
      (await t.db.select({ key: jobs.idempotencyKey }).from(jobs).where(like(jobs.idempotencyKey, `${tag}:%`)))
        .map((row) => row.key.slice(tag.length + 1))
        .sort();

    // Only test data first: the jobs of the demo session stay.
    const testOnly = await t.db.transaction((tx) => deleteDemoAndTestData(tx, { studyId, modes: ["test"] }));
    expect(testOnly.deleted.jobs).toBe(4);
    // The file of the unfinished clean-up job is handed to the caller, the finished one is not.
    expect(testOnly.pendingStorageDeletions).toEqual([testDiscarded]);
    expect(await remaining()).toEqual(
      ["demo-asr", "demo-derive", "empty", "export", "research-asr", "research-batch", "research-delete", "research-derive"].sort(),
    );

    const rest = await t.db.transaction((tx) => deleteDemoAndTestData(tx, { studyId }));
    expect(rest.deleted.jobs).toBe(2);
    expect(rest.pendingStorageDeletions).toEqual([]);
    expect(await remaining()).toEqual(["empty", "export", "research-asr", "research-batch", "research-delete", "research-derive"].sort());
  });

  it("rejects research as a mode", async () => {
    const study = await insertStudy(t.db);
    await expect(
      t.db.transaction((tx) => deleteDemoAndTestData(tx, { studyId: study.id, modes: ["research" as "test"] })),
    ).rejects.toThrow(/only accepts/);
  });
});
