// The example text guard and the wording checks of the publish check
// (spec 6.1, 6.4, 49, 91, 143).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { protocolVersions, studies } from "@dialect/db";
import { seedDevelopmentData } from "@dialect/db/seed";
import {
  insertConsentVersion,
  insertDraftProtocol,
  insertPublishedProtocol,
  insertQuestionnaire,
  insertStudy,
} from "@dialect/db/testing-builders";
import { protocolSchemas } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  currentProtocolExampleText,
  currentProtocolHasExampleText,
  participantTitleOf,
  primingFindings,
  publishProtocol,
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

const wording = (problems: Array<{ code: string; field?: string }>) =>
  problems.filter((problem) => problem.code.startsWith("wording_")).map((problem) => [problem.code, problem.field]);

describe("wording checks on every text shown before the last speech task", () => {
  it("names the field for the information text, the consent texts, the task texts and the participant title", async () => {
    const study = await insertStudy(ctx.db, {
      settingsJson: { participantTitle: "Dialect study" } as typeof studies.$inferInsert.settingsJson,
    });
    const consent = await insertConsentVersion(ctx.db, {
      studyId: study.id,
      title: "Consent to the dialect study",
      informationText: "We expect that regional speech is flattened.",
      contactText: "Murteiden tutkimusryhmä",
      itemsJson: [{ id: "participation", text: "I agree to take part in the dialect study.", required: true }],
    });
    const draft = await insertDraftProtocol(ctx.db, {
      studyId: study.id,
      consentVersionId: consent.id,
      informationContent: "This study is about Finnish dialects.",
      debriefContent: "We studied dialect.",
      tasks: [
        {
          taskKey: "enabled_task",
          taskType: "semi_structured",
          title: "Your dialect",
          participantPrompt: "Puhu murteella.",
          contextText: "Kerro murteestasi.",
          instructionsText: "Exaggerate your accent.",
          blockKey: "main",
          configJson: { topicSuggestions: ["Kotiseutu", "Murteita Suomessa"] },
          followups: [
            { followupKey: "primes", promptText: "How does your dialect sound?" },
            { followupKey: "off", promptText: "Dialect again.", enabled: false },
          ],
        },
        {
          taskKey: "disabled_task",
          taskType: "controlled",
          title: "Dialect, but disabled",
          participantPrompt: "Dialect.",
          blockKey: "main",
          enabled: false,
        },
      ],
    });

    const result = await validateProtocolForPublish(ctx, draft.protocol.id);
    expect(wording(result.warnings)).toEqual([
      ["wording_mentions_dialect", "participantTitle"],
      ["wording_mentions_dialect", "informationContent"],
      ["wording_mentions_dialect", "consent.title"],
      ["wording_states_hypothesis", "consent.informationText"],
      ["wording_mentions_dialect", "consent.contactText"],
      ["wording_mentions_dialect", "consent.items.participation"],
      ["wording_mentions_dialect", "task.title"],
      ["wording_mentions_dialect", "task.participantPrompt"],
      ["wording_mentions_dialect", "task.contextText"],
      ["wording_asks_for_marked_speech", "task.instructionsText"],
      ["wording_mentions_dialect", "task.followups.primes"],
      ["wording_mentions_dialect", "task.topicSuggestions.1"],
    ]);
    // Task warnings point at the task.
    const taskWarnings = result.warnings.filter((problem) => problem.field?.startsWith("task."));
    expect(taskWarnings.every((problem) => problem.taskKey === "enabled_task")).toBe(true);
    // The messages name the text in plain words.
    expect(result.warnings.find((problem) => problem.field === "consent.title")?.message).toMatch(
      /^The title of consent v1 mentions dialect/,
    );
    // Wording warnings never block publishing.
    expect(result.errors.filter((problem) => problem.code.startsWith("wording_"))).toEqual([]);
  });

  it("does not check the questionnaires, which ask about dialect on purpose after the speech tasks", async () => {
    const study = await insertStudy(ctx.db);
    const background = await insertQuestionnaire(ctx.db, {
      studyId: study.id,
      key: "background",
      name: "Background",
      items: [
        {
          itemKey: "variety",
          type: "short_text",
          prompt: "Do you feel that you speak a regional variety or dialect of Finnish?",
          required: false,
        },
      ],
    });
    const published = await insertPublishedProtocol(ctx.db, {
      studyId: study.id,
      backgroundQuestionnaireVersionId: background.version.id,
    });
    const result = await validateProtocolForPublish(ctx, published.protocol.id);
    expect(wording(result.warnings)).toEqual([]);
  });

  it("finds the Finnish stems in inflected forms", () => {
    for (const text of ["murre", "Murteen piirteet", "murteella", "murteita", "savolaismurteet"]) {
      expect(primingFindings("The text", text).map((finding) => finding.code)).toEqual(["wording_mentions_dialect"]);
    }
    expect(primingFindings("The text", "Puhu niin kuin tavallisesti puhut.")).toEqual([]);
    expect(primingFindings("The text", null)).toEqual([]);
  });
});

describe("example text guard", () => {
  it("blocks publishing with one error per field that still contains a marker", async () => {
    const study = await insertStudy(ctx.db);
    const consent = await insertConsentVersion(ctx.db, {
      studyId: study.id,
      contactText: `[${protocolSchemas.EXAMPLE_TEXT_PREFIX}: name of the responsible researcher.]`,
    });
    const post = await insertQuestionnaire(ctx.db, {
      studyId: study.id,
      key: "post_recording",
      items: [
        {
          itemKey: "comment",
          type: "free_text",
          prompt: "Anything else?",
          helpText: protocolSchemas.EXAMPLE_TEXT_NOTICE,
          required: false,
        },
      ],
    });
    const draft = await insertDraftProtocol(ctx.db, {
      studyId: study.id,
      consentVersionId: consent.id,
      postQuestionnaireVersionId: post.version.id,
      description: "[PLACEHOLDER] Example protocol.",
      welcomeContent: `${protocolSchemas.EXAMPLE_TEXT_NOTICE}\n\nWelcome.`,
      tasks: [
        {
          taskKey: "task_1",
          taskType: "controlled",
          title: "A task",
          participantPrompt: `${protocolSchemas.EXAMPLE_TEXT_NOTICE} Say something.`,
          blockKey: "main",
        },
      ],
    });

    const result = await validateProtocolForPublish(ctx, draft.protocol.id);
    const found = result.errors.filter((problem) => problem.code === "example_text_present");
    expect(found.map((problem) => problem.field)).toEqual([
      "description",
      "welcomeContent",
      "consent.contactText",
      "task.participantPrompt",
      "questionnaire.post_recording.items.comment",
    ]);
    expect(found[1]?.message).toBe(
      "The welcome text still contains example text. Replace it with the approved study text.",
    );
    expect(result.canPublish).toBe(false);
    await expect(publishProtocol(ctx, draft.protocol.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const [stored] = await ctx.db.select().from(protocolVersions).where(eq(protocolVersions.id, draft.protocol.id));
    expect(stored?.status).toBe("draft");
  });

  it("finds example text and dialect wording in the translations of the study texts", async () => {
    const study = await insertStudy(ctx.db);
    const consent = await insertConsentVersion(ctx.db, {
      studyId: study.id,
      translationsJson: { fi: { items: { participation: `${protocolSchemas.EXAMPLE_TEXT_NOTICE_FI} Suostun.` } } },
    });
    const draft = await insertDraftProtocol(ctx.db, {
      studyId: study.id,
      consentVersionId: consent.id,
      translationsJson: { fi: { welcomeContent: `${protocolSchemas.EXAMPLE_TEXT_NOTICE_FI}\n\nTervetuloa.` } },
      tasks: [
        {
          taskKey: "task_1",
          taskType: "controlled",
          title: "A task",
          participantPrompt: "Say something.",
          blockKey: "main",
          translationsJson: { fi: { participantPrompt: "Puhu omalla murteellasi." } },
        },
      ],
    });
    const result = await validateProtocolForPublish(ctx, draft.protocol.id);
    expect(result.errors.filter((problem) => problem.code === "example_text_present").map((problem) => problem.field)).toEqual([
      "translations",
      "consent.translations",
    ]);
    expect(wording(result.warnings)).toEqual([["wording_mentions_dialect", "task.translations"]]);
    expect(result.canPublish).toBe(false);
  });

  it("reports nothing for a protocol without example text", async () => {
    const study = await insertStudy(ctx.db);
    const published = await insertPublishedProtocol(ctx.db, { studyId: study.id, setAsCurrent: true });
    const result = await validateProtocolForPublish(ctx, published.protocol.id);
    expect(result.errors).toEqual([]);
    expect(await currentProtocolHasExampleText(ctx, study.id)).toBe(false);
    expect(await currentProtocolExampleText(ctx, study.id)).toMatchObject({ present: false, fields: [] });
  });

  it("is false for a study without a current protocol", async () => {
    const study = await insertStudy(ctx.db);
    expect(await currentProtocolHasExampleText(ctx, study.id)).toBe(false);
  });

  it("finds the example text of the protocol that the development seed publishes", async () => {
    const seeded = await seedDevelopmentData(ctx.db);
    expect(await currentProtocolHasExampleText(ctx, seeded.studyId)).toBe(true);
    const status = await currentProtocolExampleText(ctx, seeded.studyId);
    expect(status.versionNumber).toBe(1);
    expect(status.fields.map((entry) => entry.field)).toEqual([
      "description",
      "welcomeContent",
      "informationContent",
      "instructionContent",
      "debriefContent",
      // The Finnish texts of the seed carry the Finnish example marker.
      "translations",
      "consent.informationText",
      "consent.contactText",
      "consent.translations",
    ]);

    // The seeded draft cannot be published as it is, and its wording raises no priming warning.
    const [draft] = await ctx.db
      .select()
      .from(protocolVersions)
      .where(eq(protocolVersions.status, "draft"))
      .then((rows) => rows.filter((row) => row.studyId === seeded.studyId));
    const result = await validateProtocolForPublish(ctx, draft!.id);
    expect(result.canPublish).toBe(false);
    expect([...new Set(result.errors.map((problem) => problem.code))]).toEqual(["example_text_present"]);
    expect(wording(result.warnings)).toEqual([]);

    // The seeded participant title is neutral and is not the internal study name.
    const [study] = await ctx.db.select().from(studies).where(eq(studies.id, seeded.studyId));
    expect(participantTitleOf(study!)).toBe("Speech and translation study");
    expect(participantTitleOf(study!)).not.toBe(study!.name);
    expect(primingFindings("The title", participantTitleOf(study!))).toEqual([]);
  });

  it("falls back to a neutral title, never to the internal study name", async () => {
    const study = await insertStudy(ctx.db, { name: "Dialect-Aware Speech Translation Study" });
    expect(participantTitleOf(study)).toBe(protocolSchemas.NEUTRAL_PARTICIPANT_TITLE);
    expect(primingFindings("The title", protocolSchemas.NEUTRAL_PARTICIPANT_TITLE)).toEqual([]);
  });
});
