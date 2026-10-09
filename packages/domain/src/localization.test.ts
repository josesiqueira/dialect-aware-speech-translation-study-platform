import { describe, expect, it } from "vitest";
import {
  compactTranslations,
  keyedTranslationOf,
  localizeKeyed,
  localizeList,
  localizeText,
  questionnaireItemTranslationsSchema,
  taskTranslationsSchema,
  translatedTexts,
  translationOf,
  withTranslation,
} from "./localization";
import { protocolSchemas } from "./index";

const translations = {
  fi: {
    participantPrompt: "Kerro paikasta, jossa kasvoit.",
    contextText: "   ",
    items: { participation: "Suostun osallistumaan." },
    topicSuggestions: ["Koti", ""],
  },
};

describe("localizeText", () => {
  it("returns the translation of the locale", () => {
    expect(localizeText("Tell us about the place.", translations, "fi", "participantPrompt")).toBe(
      "Kerro paikasta, jossa kasvoit.",
    );
  });

  it("falls back to the base text for another locale, a missing field, an empty translation or no locale", () => {
    expect(localizeText("Base", translations, "en", "participantPrompt")).toBe("Base");
    expect(localizeText("Base", translations, "fi", "title")).toBe("Base");
    expect(localizeText("Base", translations, "fi", "contextText")).toBe("Base");
    expect(localizeText("Base", translations, null, "participantPrompt")).toBe("Base");
    expect(localizeText(null, {}, "fi", "contextText")).toBeNull();
  });

  it("ignores stored values that are not objects", () => {
    expect(localizeText("Base", null, "fi", "title")).toBe("Base");
    expect(localizeText("Base", { fi: "not an object" }, "fi", "title")).toBe("Base");
  });
});

describe("keyed and list texts", () => {
  it("translates a consent item by its id and falls back for another id", () => {
    expect(localizeKeyed("I agree.", translations, "fi", "items", "participation")).toBe("Suostun osallistumaan.");
    expect(localizeKeyed("I agree to be recorded.", translations, "fi", "items", "voice_recording")).toBe(
      "I agree to be recorded.",
    );
  });

  it("uses the translated list without its empty entries, and the base list when nothing is left", () => {
    expect(localizeList(["Home"], translations, "fi", "topicSuggestions")).toEqual(["Koti"]);
    expect(localizeList(["Home"], { fi: { topicSuggestions: [" "] } }, "fi", "topicSuggestions")).toEqual(["Home"]);
    expect(localizeList(["Home"], translations, "en", "topicSuggestions")).toEqual(["Home"]);
  });
});

describe("editing helpers", () => {
  it("drops empty texts, empty maps and empty locales", () => {
    expect(compactTranslations(translations)).toEqual({
      fi: {
        participantPrompt: "Kerro paikasta, jossa kasvoit.",
        items: { participation: "Suostun osallistumaan." },
        topicSuggestions: ["Koti"],
      },
    });
    expect(compactTranslations({ fi: { title: "" }, sv: {} })).toEqual({});
    expect(compactTranslations(null)).toEqual({});
  });

  it("sets one field and keeps the others", () => {
    const next = withTranslation(translations, "fi", "title", "Kotiseutu");
    expect(translationOf(next, "fi", "title")).toBe("Kotiseutu");
    expect(translationOf(next, "fi", "participantPrompt")).toBe("Kerro paikasta, jossa kasvoit.");
    expect(keyedTranslationOf(next, "fi", "items", "participation")).toBe("Suostun osallistumaan.");
    expect(translationOf(withTranslation(next, "fi", "title", ""), "fi", "title")).toBe("");
  });

  it("lists every translated text for checks over all texts", () => {
    expect(translatedTexts(translations).sort()).toEqual(
      ["   ", "", "Kerro paikasta, jossa kasvoit.", "Koti", "Suostun osallistumaan."].sort(),
    );
  });
});

describe("request schemas", () => {
  it("accept the fields of the record and refuse unknown fields and locales", () => {
    expect(taskTranslationsSchema.safeParse({ fi: { title: "Kutsu", topicSuggestions: ["Koti"] } }).success).toBe(true);
    expect(taskTranslationsSchema.safeParse({ fi: { welcomeContent: "x" } }).success).toBe(false);
    expect(taskTranslationsSchema.safeParse({ "not a locale": { title: "x" } }).success).toBe(false);
    expect(questionnaireItemTranslationsSchema.safeParse({ fi: { options: { yes: "Kyllä" } } }).success).toBe(true);
  });
});

describe("example text markers", () => {
  it("recognize the Finnish notice of the seed", () => {
    expect(protocolSchemas.containsExampleText(`${protocolSchemas.EXAMPLE_TEXT_NOTICE_FI}\n\nTervetuloa.`)).toBe(true);
    expect(protocolSchemas.containsExampleText("Tervetuloa tutkimukseen.")).toBe(false);
  });

  it("give the neutral title in Finnish", () => {
    expect(protocolSchemas.neutralParticipantTitle("fi")).toBe("Tutkimus");
    expect(protocolSchemas.neutralParticipantTitle("en")).toBe(protocolSchemas.NEUTRAL_PARTICIPANT_TITLE);
    expect(protocolSchemas.neutralParticipantTitle(null)).toBe(protocolSchemas.NEUTRAL_PARTICIPANT_TITLE);
  });
});
