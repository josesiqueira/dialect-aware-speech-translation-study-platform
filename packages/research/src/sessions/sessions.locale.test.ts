// Study texts in the language of the session (packages/domain/src/localization.ts).
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionConsents, taskPresentations, utterances } from "@dialect/db";
import {
  insertConsentVersion,
  insertPublishedProtocol,
  insertQuestionnaire,
  insertStudy,
} from "@dialect/db/testing-builders";
import { AppError } from "@dialect/domain";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  acknowledgeInstructions,
  confirmMicCheck,
  createSession,
  getParticipantState,
  getPublicStudyInfo,
  recordConsent,
  setSessionLocale,
  submitQuestionnaire,
} from "./index";
import { acceptAll, answerAllTasks, answerCurrentTurn, expectStep } from "./test-support";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestServiceContext;
let slug: string;

beforeAll(async () => {
  t = await createTestServiceContext();
  const study = await insertStudy(t.ctx.db, {
    settingsJson: {
      allowNewSessions: true,
      autoQueueAsr: false,
      participantLocales: ["fi", "en"],
      defaultLocale: "fi",
      participantTitle: "Speech study",
      participantTitleTranslations: { fi: "Puhetutkimus" },
    },
  });
  slug = study.slug;
  const background = await insertQuestionnaire(t.ctx.db, {
    studyId: study.id,
    key: "background",
    name: "Background",
    translationsJson: { fi: { name: "Tausta" } },
    items: [
      {
        itemKey: "speaks_often",
        type: "single_choice",
        prompt: "Do you speak Finnish every day?",
        helpText: "Choose one.",
        required: true,
        configJson: { options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
        translationsJson: { fi: { prompt: "Puhutko suomea joka päivä?", options: { yes: "Kyllä" } } },
      },
    ],
  });
  const post = await insertQuestionnaire(t.ctx.db, {
    studyId: study.id,
    key: "post_recording",
    name: "After recording",
    items: [
      {
        itemKey: "naturalness",
        type: "likert",
        prompt: "How natural did it feel?",
        required: true,
        configJson: { scaleMin: 1, scaleMax: 5, scaleMinLabel: "Not at all", scaleMaxLabel: "Very" },
        translationsJson: { fi: { prompt: "Kuinka luontevalta tuntui?", scaleMinLabel: "Ei lainkaan" } },
      },
    ],
  });
  const consent = await insertConsentVersion(t.ctx.db, {
    studyId: study.id,
    title: "Consent",
    informationText: "Information.",
    contactText: "Contact us.",
    itemsJson: [
      { id: "participation", text: "I agree to take part.", required: true },
      { id: "voice_recording", text: "I agree to be recorded.", required: true },
    ],
    translationsJson: {
      fi: {
        title: "Suostumus",
        informationText: "Tiedote.",
        contactText: "Ota yhteyttä.",
        items: { participation: "Suostun osallistumaan." },
      },
    },
  });
  await insertPublishedProtocol(t.ctx.db, {
    studyId: study.id,
    consentVersionId: consent.id,
    backgroundQuestionnaireVersionId: background.version.id,
    postQuestionnaireVersionId: post.version.id,
    welcomeContent: "Welcome.",
    informationContent: "About the study.",
    instructionContent: "Speak naturally.",
    debriefContent: "Thank you.",
    translationsJson: {
      fi: {
        welcomeContent: "Tervetuloa.",
        informationContent: "Tutkimuksesta.",
        instructionContent: "Puhu luontevasti.",
        debriefContent: "Kiitos.",
      },
    },
    tasks: [
      {
        taskKey: "grew_up",
        taskType: "semi_structured",
        title: "Where you grew up",
        participantPrompt: "Tell us about the place where you grew up.",
        blockKey: "main",
        configJson: { topicSuggestions: ["Home"] },
        translationsJson: {
          fi: { title: "Missä kasvoit", participantPrompt: "Kerro paikasta, jossa kasvoit.", topicSuggestions: ["Koti"] },
        },
        followups: [
          {
            followupKey: "typical",
            promptText: "Tell us about a typical situation.",
            translationsJson: { fi: { promptText: "Kerro tyypillisestä tilanteesta." } },
          },
        ],
      },
    ],
  });
});

afterAll(async () => {
  await t?.cleanup();
});

describe("study texts in the language of the session", () => {
  it("gives the welcome page the title and the welcome text of every language", async () => {
    const info = await getPublicStudyInfo(t.ctx, { studySlug: slug });
    expect(info.studyNameByLocale).toEqual({ fi: "Puhetutkimus", en: "Speech study" });
    expect(info.welcomeContentByLocale).toEqual({ fi: "Tervetuloa.", en: "Welcome." });
  });

  it("shows, stores and switches the texts by the locale of the session", async () => {
    const created = await createSession(t.ctx, { studySlug: slug, locale: "fi" });
    const session = created.session;

    // Consent: Finnish texts, an item without a translation stays in the base text.
    const consentStep = expectStep(created.state, "consent");
    expect(consentStep.studyName).toBe("Puhetutkimus");
    expect(consentStep.information.content).toBe("Tutkimuksesta.");
    expect(consentStep.consent).toMatchObject({ title: "Suostumus", informationText: "Tiedote.", contactText: "Ota yhteyttä." });
    expect(consentStep.consent.items.map((item) => item.text)).toEqual(["Suostun osallistumaan.", "I agree to be recorded."]);

    // The stored consent record holds the texts the participant read.
    await recordConsent(t.ctx, session, { responses: acceptAll(created.state) });
    const [consentRow] = await t.ctx.db.select().from(sessionConsents).where(eq(sessionConsents.sessionId, session.id));
    expect(consentRow!.responsesJson.map((response) => response.textSnapshot)).toEqual([
      "Suostun osallistumaan.",
      "I agree to be recorded.",
    ]);

    await confirmMicCheck(t.ctx, session, {});
    const tasks = expectStep(await acknowledgeInstructions(t.ctx, session), "tasks");
    expect(tasks.task).toMatchObject({ title: "Missä kasvoit", prompt: "Kerro paikasta, jossa kasvoit.", topicSuggestions: ["Koti"] });
    const [presentation] = await t.ctx.db
      .select()
      .from(taskPresentations)
      .where(eq(taskPresentations.sessionId, session.id));
    expect(presentation).toMatchObject({
      titleSnapshot: "Missä kasvoit",
      promptSnapshot: "Kerro paikasta, jossa kasvoit.",
      snapshotLocale: "fi",
    });

    // The follow-up in Finnish, and the recording keeps the prompt that was shown.
    const afterMain = expectStep((await answerCurrentTurn(t.ctx, session)).state, "tasks");
    expect(afterMain.task.turn).toMatchObject({ isFollowup: true, promptText: "Kerro tyypillisestä tilanteesta." });

    // Switching to English: the texts that follow are English, the stored snapshot is unchanged.
    const english = expectStep(await setSessionLocale(t.ctx, session, { locale: "en" }), "tasks");
    expect(english.locale).toBe("en");
    expect(english.studyName).toBe("Speech study");
    expect(english.task).toMatchObject({ title: "Where you grew up", topicSuggestions: ["Home"] });
    expect(english.task.turn.promptText).toBe("Tell us about a typical situation.");
    await answerCurrentTurn(t.ctx, session);
    const rows = await t.ctx.db
      .select({ promptSnapshot: utterances.promptSnapshot })
      .from(utterances)
      .where(eq(utterances.sessionId, session.id))
      .orderBy(asc(utterances.turnIndex));
    expect(rows.map((row) => row.promptSnapshot)).toEqual([
      "Kerro paikasta, jossa kasvoit.",
      "Tell us about a typical situation.",
    ]);
    const [unchanged] = await t.ctx.db.select().from(taskPresentations).where(eq(taskPresentations.id, presentation!.id));
    expect(unchanged!.titleSnapshot).toBe("Missä kasvoit");

    // A language the study does not offer is refused.
    await expect(setSessionLocale(t.ctx, session, { locale: "sv" })).rejects.toSatisfy(
      (error) => error instanceof AppError && error.code === "VALIDATION_ERROR",
    );

    // Back to Finnish for the questionnaires and the debrief.
    await answerAllTasks(t.ctx, session);
    const background = expectStep(await setSessionLocale(t.ctx, session, { locale: "fi" }), "background");
    expect(background.questionnaire.name).toBe("Tausta");
    const [choice] = background.questionnaire.items;
    expect(choice).toMatchObject({ prompt: "Puhutko suomea joka päivä?", helpText: "Choose one." });
    expect(choice!.config.options).toEqual([
      { value: "yes", label: "Kyllä" },
      { value: "no", label: "No" },
    ]);
    const post = expectStep(
      await submitQuestionnaire(t.ctx, session, { key: "background", answers: { speaks_often: "yes" } }),
      "post_recording",
    );
    expect(post.questionnaire.items[0]).toMatchObject({ prompt: "Kuinka luontevalta tuntui?" });
    expect(post.questionnaire.items[0]!.config).toMatchObject({ scaleMinLabel: "Ei lainkaan", scaleMaxLabel: "Very" });
    const debrief = expectStep(
      await submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: { naturalness: 4 } }),
      "debrief",
    );
    expect(debrief.debrief).toEqual({ content: "Kiitos.", contactText: "Ota yhteyttä." });
    expect((await getParticipantState(t.ctx, session)).locale).toBe("fi");
  });
});
