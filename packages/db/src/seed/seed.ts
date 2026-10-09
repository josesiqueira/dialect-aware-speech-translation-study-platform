// Development seed (spec 91 to 94). Idempotent: each record is looked up by its
// natural key and only inserted when missing, so running the seed twice changes
// nothing. Existing rows are never modified (published rows are immutable).
//
// Order matters because of the database triggers: versions are inserted as
// drafts, filled with their items or tasks, then published.
import { and, eq } from "drizzle-orm";
import type { Database, Transaction } from "../client";
import {
  aiPromptVersions,
  consentVersions,
  modelConfigs,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireItems,
  questionnaireVersions,
  studies,
} from "../schema";
import {
  AI_PROMPTS,
  BACKGROUND_QUESTIONNAIRE,
  CONSENT,
  MODEL_CONFIGS,
  POST_RECORDING_QUESTIONNAIRE,
  POST_REVIEW_QUESTIONNAIRE,
  PROTOCOL,
  PROTOCOL_TASKS,
  SEED_LABEL,
  STUDY,
  STUDY_SETTINGS,
} from "./content";

export type SeedResult = {
  studyId: string;
  // Names of the records this run inserted. Empty when everything already existed.
  created: string[];
};

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Expected the insert to return a row");
  return row;
}

async function seedQuestionnaire(
  tx: Transaction,
  studyId: string,
  definition: typeof BACKGROUND_QUESTIONNAIRE | typeof POST_RECORDING_QUESTIONNAIRE | typeof POST_REVIEW_QUESTIONNAIRE,
  created: string[],
): Promise<string> {
  const [existing] = await tx
    .select()
    .from(questionnaireVersions)
    .where(
      and(
        eq(questionnaireVersions.studyId, studyId),
        eq(questionnaireVersions.key, definition.key),
        eq(questionnaireVersions.versionNumber, 1),
      ),
    );
  if (existing) return existing.id;

  const version = one(
    await tx
      .insert(questionnaireVersions)
      .values({
        studyId,
        key: definition.key,
        versionNumber: 1,
        status: "draft",
        name: definition.name,
        description: definition.description,
        translationsJson: definition.translations,
        createdByLabel: SEED_LABEL,
      })
      .returning(),
  );
  await tx.insert(questionnaireItems).values(
    definition.items.map((item, index) => ({
      ...item,
      orderIndex: index,
      questionnaireVersionId: version.id,
    })),
  );
  await tx
    .update(questionnaireVersions)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(questionnaireVersions.id, version.id));
  created.push(`questionnaire ${definition.key} v1 (published)`);
  return version.id;
}

async function insertProtocolTasks(tx: Transaction, protocolVersionId: string): Promise<void> {
  for (const [index, definition] of PROTOCOL_TASKS.entries()) {
    const { followups, ...task } = definition;
    const taskRow = one(
      await tx
        .insert(protocolTasks)
        .values({ ...task, orderIndex: index, protocolVersionId })
        .returning(),
    );
    if (followups.length > 0) {
      await tx.insert(protocolTaskFollowups).values(
        followups.map((followup, followupIndex) => ({
          ...followup,
          orderIndex: followupIndex,
          protocolTaskId: taskRow.id,
        })),
      );
    }
  }
}

export async function seedDevelopmentData(db: Database): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const created: string[] = [];

    // Study
    let [study] = await tx.select().from(studies).where(eq(studies.slug, STUDY.slug));
    if (!study) {
      study = one(
        await tx
          .insert(studies)
          .values({ slug: STUDY.slug, name: STUDY.name, status: "active", settingsJson: STUDY_SETTINGS })
          .returning(),
      );
      created.push("study");
    }
    const studyId = study.id;

    // Consent version 1, published
    let [consent] = await tx
      .select()
      .from(consentVersions)
      .where(and(eq(consentVersions.studyId, studyId), eq(consentVersions.versionNumber, 1)));
    if (!consent) {
      consent = one(
        await tx
          .insert(consentVersions)
          .values({
            studyId,
            versionNumber: 1,
            title: CONSENT.title,
            informationText: CONSENT.informationText,
            privacyNoticeUrl: CONSENT.privacyNoticeUrl,
            contactText: CONSENT.contactText,
            itemsJson: CONSENT.items,
            translationsJson: CONSENT.translations,
            publishedAt: new Date(),
            createdByLabel: SEED_LABEL,
          })
          .returning(),
      );
      created.push("consent v1 (published)");
    }

    // Questionnaires, published
    const backgroundId = await seedQuestionnaire(tx, studyId, BACKGROUND_QUESTIONNAIRE, created);
    const postRecordingId = await seedQuestionnaire(tx, studyId, POST_RECORDING_QUESTIONNAIRE, created);
    const postReviewId = await seedQuestionnaire(tx, studyId, POST_REVIEW_QUESTIONNAIRE, created);

    // Protocol version 1: draft, tasks, publish, set as the current protocol
    const protocolContent = {
      name: PROTOCOL.name,
      description: PROTOCOL.description,
      welcomeContent: PROTOCOL.welcomeContent,
      informationContent: PROTOCOL.informationContent,
      instructionContent: PROTOCOL.instructionContent,
      debriefContent: PROTOCOL.debriefContent,
      translationsJson: PROTOCOL.translations,
      consentVersionId: consent.id,
      backgroundQuestionnaireVersionId: backgroundId,
      postQuestionnaireVersionId: postRecordingId,
      postReviewQuestionnaireVersionId: postReviewId,
      orderConfigJson: PROTOCOL.orderConfig,
      createdByLabel: SEED_LABEL,
    };
    let [protocolV1] = await tx
      .select()
      .from(protocolVersions)
      .where(and(eq(protocolVersions.studyId, studyId), eq(protocolVersions.versionNumber, 1)));
    if (!protocolV1) {
      protocolV1 = one(
        await tx
          .insert(protocolVersions)
          .values({ ...protocolContent, studyId, versionNumber: 1, status: "draft" })
          .returning(),
      );
      await insertProtocolTasks(tx, protocolV1.id);
      await tx
        .update(protocolVersions)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(protocolVersions.id, protocolV1.id));
      created.push("protocol v1 (published)");
    }
    if (!study.currentProtocolVersionId) {
      await tx.update(studies).set({ currentProtocolVersionId: protocolV1.id }).where(eq(studies.id, studyId));
    }

    // Protocol version 2: a draft cloned from version 1
    const [protocolV2] = await tx
      .select()
      .from(protocolVersions)
      .where(and(eq(protocolVersions.studyId, studyId), eq(protocolVersions.versionNumber, 2)));
    if (!protocolV2) {
      const draft = one(
        await tx
          .insert(protocolVersions)
          .values({
            ...protocolContent,
            studyId,
            versionNumber: 2,
            status: "draft",
            name: `${PROTOCOL.name} (draft copy)`,
            clonedFromProtocolVersionId: protocolV1.id,
          })
          .returning(),
      );
      await insertProtocolTasks(tx, draft.id);
      created.push("protocol v2 (draft)");
    }

    // AI prompt versions, active
    const promptIds = new Map<string, string>();
    for (const definition of AI_PROMPTS) {
      let [prompt] = await tx
        .select()
        .from(aiPromptVersions)
        .where(
          and(
            eq(aiPromptVersions.studyId, studyId),
            eq(aiPromptVersions.key, definition.key),
            eq(aiPromptVersions.versionNumber, 1),
          ),
        );
      if (!prompt) {
        prompt = one(
          await tx
            .insert(aiPromptVersions)
            .values({
              studyId,
              key: definition.key,
              stage: definition.stage,
              conditionKey: definition.conditionKey,
              versionNumber: 1,
              status: "active",
              name: definition.name,
              promptText: definition.promptText,
              notes: definition.notes,
              activatedAt: new Date(),
              createdByLabel: SEED_LABEL,
            })
            .returning(),
        );
        created.push(`prompt ${definition.key} v1 (active)`);
      }
      promptIds.set(definition.key, prompt.id);
    }

    // Model configs, active, linked to their prompts
    for (const definition of MODEL_CONFIGS) {
      const [config] = await tx
        .select()
        .from(modelConfigs)
        .where(
          and(
            eq(modelConfigs.studyId, studyId),
            eq(modelConfigs.key, definition.key),
            eq(modelConfigs.versionNumber, 1),
          ),
        );
      if (!config) {
        await tx.insert(modelConfigs).values({
          studyId,
          key: definition.key,
          stage: definition.stage,
          conditionKey: definition.conditionKey,
          versionNumber: 1,
          status: "active",
          name: definition.name,
          provider: definition.provider,
          modelId: definition.modelId,
          parametersJson: definition.parameters,
          promptVersionId: promptIds.get(definition.promptKey) ?? null,
          activatedAt: new Date(),
          createdByLabel: SEED_LABEL,
        });
        created.push(`model config ${definition.key} v1 (active)`);
      }
    }

    return { studyId, created };
  });
}
