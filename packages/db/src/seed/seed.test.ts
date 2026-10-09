import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiPromptVersions,
  consentVersions,
  modelConfigs,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireItems,
  questionnaireVersions,
  sessions,
  studies,
} from "../schema";
import { protocolSchemas } from "@dialect/domain";
import { createTestDatabase, type TestDatabase } from "../testing";
import { EXAMPLE_TEXT_NOTICE } from "./content";
import { seedDevelopmentData } from "./seed";

// Words a participant must never read: the internal marker, and references to the specification.
const INTERNAL_WORDING = /placeholder|\bspec\b|specification/i;

describe("development seed", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  async function rowCounts(): Promise<Record<string, number>> {
    const tables = await t.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    const counts: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
      const result = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table_name)}`);
      counts[table_name] = result.rows[0]?.n ?? 0;
    }
    return counts;
  }

  it("creates the development records and is safe to run twice", async () => {
    const first = await seedDevelopmentData(t.db);
    expect(first.created).toHaveLength(15);
    const afterFirst = await rowCounts();
    expect(afterFirst).toMatchObject({
      studies: 1,
      consent_versions: 1,
      questionnaire_versions: 3,
      questionnaire_items: 22,
      protocol_versions: 2,
      protocol_tasks: 10,
      protocol_task_followups: 2,
      ai_prompt_versions: 4,
      model_configs: 4,
      sessions: 0,
      media_assets: 0,
    });

    const snapshot = await t.db.select().from(protocolVersions).orderBy(protocolVersions.versionNumber);
    const second = await seedDevelopmentData(t.db);
    expect(second.studyId).toBe(first.studyId);
    expect(second.created).toEqual([]);
    expect(await rowCounts()).toEqual(afterFirst);
    // The second run did not touch existing rows.
    expect(await t.db.select().from(protocolVersions).orderBy(protocolVersions.versionNumber)).toEqual(snapshot);
  });

  it("stores the study with explicit settings and protocol 1 as the current protocol", async () => {
    const [study] = await t.db.select().from(studies);
    expect(study?.slug).toBe("dialect-translation-study");
    expect(study?.name).toBe("Dialect-Aware Speech Translation Study");
    // A new deployment takes no participants: the seeded study texts are examples.
    expect(study?.settingsJson).toMatchObject({
      allowNewSessions: false,
      participantTitle: "Speech and translation study",
      demoDailyRunLimit: 200,
      autoQueueAsr: true,
      maxUploadMb: 100,
      maxUtteranceSeconds: 300,
      sessionInactivityTimeoutMinutes: 120,
      studyLaptopMode: false,
      demoPersist: true,
      demoPublic: false,
      sourceLanguage: "fi",
      targetLanguage: "en",
      participantLocales: ["fi", "en"],
      defaultLocale: "fi",
      transcriptionConventionVersion: "1.0",
      annotationSchemeVersion: "1.0",
      adminTimezone: "Europe/Helsinki",
    });
    // The title participants see before they speak names no research focus (spec 6.4).
    const participantTitle = (study?.settingsJson as { participantTitle?: string }).participantTitle ?? "";
    expect(participantTitle.toLowerCase()).not.toMatch(/dialect|murre|murte|regional|variet/);
    const protocols = await t.db.select().from(protocolVersions).orderBy(protocolVersions.versionNumber);
    const [v1, v2] = protocols;
    expect(v1?.status).toBe("published");
    expect(v1?.publishedAt).not.toBeNull();
    expect(study?.currentProtocolVersionId).toBe(v1?.id);
    expect(v2?.status).toBe("draft");
    expect(v2?.clonedFromProtocolVersionId).toBe(v1?.id);
    expect(v1?.orderConfigJson.blocks).toEqual([
      { key: "controlled", title: "Controlled tasks", orderMode: "shuffle_within_block" },
      { key: "semi_structured", title: "Semi-structured tasks", orderMode: "fixed" },
      { key: "free", title: "Free speech", orderMode: "fixed" },
    ]);
    // Texts a participant can see carry the neutral notice, never internal wording.
    for (const text of [v1?.welcomeContent, v1?.informationContent, v1?.instructionContent, v1?.debriefContent]) {
      expect(text).toContain(EXAMPLE_TEXT_NOTICE);
      expect(text).not.toMatch(INTERNAL_WORDING);
    }
    // The protocol description is shown in the admin only and keeps the marker.
    expect(v1?.description).toContain("[PLACEHOLDER]");
    // Spec 6.1 and 6.4: no dialect priming before the speech tasks.
    for (const text of [v1?.welcomeContent, v1?.informationContent, v1?.instructionContent]) {
      expect(text?.toLowerCase()).not.toContain("dialect");
    }
  });

  it("stores the five tasks of spec 92 in both protocol versions", async () => {
    const protocols = await t.db.select().from(protocolVersions).orderBy(protocolVersions.versionNumber);
    for (const protocol of protocols) {
      const tasks = await t.db
        .select()
        .from(protocolTasks)
        .where(eq(protocolTasks.protocolVersionId, protocol.id))
        .orderBy(protocolTasks.orderIndex);
      expect(tasks.map((task) => [task.taskType, task.blockKey, task.orderMode])).toEqual([
        ["controlled", "controlled", "shuffle_within_block"],
        ["controlled", "controlled", "shuffle_within_block"],
        ["semi_structured", "semi_structured", "fixed"],
        ["semi_structured", "semi_structured", "fixed"],
        ["free_speech", "free", "fixed"],
      ]);
      expect(tasks.map((task) => task.privacyReminder)).toEqual([false, false, false, false, true]);
      const followups = await t.db
        .select()
        .from(protocolTaskFollowups)
        .where(eq(protocolTaskFollowups.protocolTaskId, tasks[2]!.id));
      // The neutral follow-up of spec 7.2, not the one of spec 92 that asks
      // about how people speak before two further speech tasks (spec 6.4).
      expect(followups.map((followup) => [followup.followupKey, followup.promptText])).toEqual([
        ["typical_situation", "Tell us about a typical situation you remember from there."],
      ]);
      // Nothing a participant reads or hears before the last recording asks about speech variety.
      const allFollowups = await t.db.select().from(protocolTaskFollowups);
      for (const text of [...tasks.map((task) => task.participantPrompt), ...allFollowups.map((f) => f.promptText)]) {
        expect(text.toLowerCase()).not.toMatch(/dialect|murre|murte|how people speak/);
      }
    }
  });

  it("stores a published consent version with stable item ids and published questionnaires", async () => {
    const [consent] = await t.db.select().from(consentVersions);
    expect(consent?.publishedAt).not.toBeNull();
    expect(consent?.informationText).toContain(EXAMPLE_TEXT_NOTICE);
    for (const text of [consent?.title, consent?.informationText, consent?.contactText, ...(consent?.itemsJson ?? []).map((item) => item.text)]) {
      expect(text).not.toMatch(INTERNAL_WORDING);
    }
    expect(consent?.contactText).toContain("Example text, to be replaced by the research team");
    expect(consent?.itemsJson.map((item) => [item.id, item.required])).toEqual([
      ["participation", true],
      ["voice_recording", true],
      ["external_ai_processing", true],
      ["future_research_reuse", false],
      ["output_review", true],
    ]);
    const versions = await t.db.select().from(questionnaireVersions).orderBy(questionnaireVersions.key);
    expect(versions.map((version) => [version.key, version.status])).toEqual([
      ["background", "published"],
      ["post_recording", "published"],
      ["post_review", "published"],
    ]);
    const postItems = await t.db
      .select()
      .from(questionnaireItems)
      .where(eq(questionnaireItems.questionnaireVersionId, versions[1]!.id))
      .orderBy(questionnaireItems.orderIndex);
    expect(postItems.filter((item) => item.type === "likert")).toHaveLength(6);
    expect(postItems.filter((item) => item.type === "likert").every((item) => item.configJson.scaleMin === 1 && item.configJson.scaleMax === 5)).toBe(true);
    expect(postItems.at(-1)).toMatchObject({ type: "free_text", required: false });
    const backgroundItems = await t.db
      .select()
      .from(questionnaireItems)
      .where(eq(questionnaireItems.questionnaireVersionId, versions[0]!.id))
      .orderBy(questionnaireItems.orderIndex);
    expect(backgroundItems[0]).toMatchObject({ itemKey: "age_range", type: "single_choice" });
    expect(backgroundItems.find((item) => item.itemKey === "region_grew_up")?.type).toBe("short_text");
  });

  it("shows participants no internal wording in questionnaires and tasks", async () => {
    const versions = await t.db.select().from(questionnaireVersions).orderBy(questionnaireVersions.key);
    expect(versions.map((version) => version.description)).toEqual([
      "A few questions about you.",
      "A few questions about how the recording went.",
      "A few questions about what you just saw.",
    ]);
    const items = await t.db.select().from(questionnaireItems);
    const tasks = await t.db.select().from(protocolTasks);
    const followups = await t.db.select().from(protocolTaskFollowups);
    const visible = [
      ...versions.flatMap((version) => [version.name, version.description]),
      ...items.flatMap((item) => [item.prompt, item.helpText, JSON.stringify(item.configJson ?? {})]),
      ...tasks.flatMap((task) => [task.title, task.participantPrompt, task.contextText, task.instructionsText]),
      ...followups.map((followup) => followup.promptText),
    ];
    for (const text of visible) {
      if (text) expect(text, text).not.toMatch(INTERNAL_WORDING);
    }
    // Spec 6.1, 6.4: the questionnaire descriptions do not name what the study compares.
    for (const version of versions) {
      expect(version.description?.toLowerCase()).not.toMatch(/dialect|accent|standard|translation/);
    }
  });

  it("stores a Finnish text for every participant-facing text", async () => {
    const [protocol] = await t.db.select().from(protocolVersions).where(eq(protocolVersions.versionNumber, 1));
    for (const field of ["welcomeContent", "informationContent", "instructionContent", "debriefContent"] as const) {
      expect(protocol!.translationsJson.fi?.[field], field).toBeTruthy();
    }
    // The Finnish example texts carry the Finnish example notice.
    expect(protocol!.translationsJson.fi?.welcomeContent).toContain(protocolSchemas.EXAMPLE_TEXT_NOTICE_FI);

    const [consent] = await t.db.select().from(consentVersions);
    expect(Object.keys(consent!.translationsJson.fi?.items ?? {}).sort()).toEqual(
      consent!.itemsJson.map((item) => item.id).sort(),
    );

    for (const task of await t.db.select().from(protocolTasks)) {
      expect(task.translationsJson.fi?.title, task.taskKey).toBeTruthy();
      expect(task.translationsJson.fi?.participantPrompt, task.taskKey).toBeTruthy();
    }
    for (const followup of await t.db.select().from(protocolTaskFollowups)) {
      expect(followup.translationsJson.fi?.promptText, followup.followupKey).toBeTruthy();
    }
    for (const version of await t.db.select().from(questionnaireVersions)) {
      expect(version.translationsJson.fi?.name, version.key).toBeTruthy();
    }
    for (const item of await t.db.select().from(questionnaireItems)) {
      const fi = item.translationsJson.fi;
      expect(fi?.prompt, item.itemKey).toBeTruthy();
      if (item.helpText) expect(fi?.helpText, item.itemKey).toBeTruthy();
      for (const option of item.configJson.options ?? []) expect(fi?.options?.[option.value], option.value).toBeTruthy();
      if (item.configJson.scaleMinLabel) expect(fi?.scaleMinLabel, item.itemKey).toBeTruthy();
      if (item.configJson.scaleMaxLabel) expect(fi?.scaleMaxLabel, item.itemKey).toBeTruthy();
    }
    const [study] = await t.db.select().from(studies);
    expect(study!.settingsJson.participantTitleTranslations).toEqual({ fi: "Puhe- ja käännöstutkimus" });
  });

  it("stores active prompts and model configs linked to each other", async () => {
    const prompts = await t.db.select().from(aiPromptVersions).orderBy(aiPromptVersions.key);
    expect(prompts.map((prompt) => [prompt.key, prompt.stage, prompt.conditionKey, prompt.status])).toEqual([
      ["asr_context", "asr", null, "active"],
      ["translation_default", "translation", "default", "active"],
      ["translation_preserve", "translation", "preservation", "active"],
      ["tts_baseline", "tts", "baseline", "active"],
    ]);
    expect(prompts[1]?.promptText).toBe(
      "Translate the following Finnish utterance into natural spoken English.\nPreserve its meaning.\nReturn only the translation.",
    );
    expect(prompts[2]?.promptText).toContain("Do not add stereotypical dialect markers.");
    expect(prompts[3]?.promptText).toBe(
      "Speak the text naturally in conversational English.\nDo not deliberately adopt a named regional dialect.\nDo not add, omit, or paraphrase words.",
    );
    const configs = await t.db.select().from(modelConfigs).orderBy(modelConfigs.key);
    const promptKeyById = new Map(prompts.map((prompt) => [prompt.id, prompt.key]));
    expect(
      configs.map((config) => [
        config.key,
        config.status,
        config.provider,
        config.parametersJson,
        config.promptVersionId ? promptKeyById.get(config.promptVersionId) : null,
      ]),
    ).toEqual([
      ["asr_default", "active", "openai", { language: "fi" }, "asr_context"],
      // The provider is asked not to keep the translation responses.
      ["translation_default", "active", "openai", { store: false }, "translation_default"],
      ["translation_preserve", "active", "openai", { store: false }, "translation_preserve"],
      ["tts_baseline", "active", "openai", { voice: "alloy", response_format: "wav" }, "tts_baseline"],
    ]);
    expect(configs.every((config) => config.modelId.length > 0)).toBe(true);
  });

  it("creates no sessions", async () => {
    expect(await t.db.select().from(sessions)).toEqual([]);
  });
});
