import { describe, expect, it } from "vitest";
import { PARTICIPANT_ERROR_CODES, sessionSchemas } from "@dialect/domain";
import { RECORDER_MESSAGE_KEYS } from "@/lib/client/recorder/errors";
import {
  DEFAULT_MIC_CHECK_LABELS,
  DEFAULT_RECORDING_TASK_LABELS,
} from "@/components/participant/recorder/labels";
import {
  DICTIONARIES,
  INTERFACE_LOCALES,
  availableLocales,
  durationText,
  errorMessage,
  errorMessageKey,
  format,
  getDictionary,
  micCheckLabels,
  pageTitle,
  recordingTaskLabels,
  resolveLocale,
} from "./index";
import { en } from "./en";
import { fi } from "./fi";

/** Every leaf of a dictionary as [dotted path, text]. */
function leaves(value: unknown, trail: string[] = []): Array<[string, string]> {
  if (typeof value === "string") return [[trail.join("."), value]];
  if (value === null || typeof value !== "object") throw new Error(`Unexpected value at ${trail.join(".")}`);
  return Object.entries(value).flatMap(([key, entry]) => leaves(entry, [...trail, key]));
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("participant dictionaries", () => {
  const english = new Map(leaves(en));
  const finnish = new Map(leaves(fi));

  it("has the same keys in every language", () => {
    expect([...finnish.keys()].sort()).toEqual([...english.keys()].sort());
    for (const locale of INTERFACE_LOCALES) {
      expect([...new Map(leaves(DICTIONARIES[locale])).keys()].sort()).toEqual([...english.keys()].sort());
    }
  });

  it("has a text for every key (only the idle announcement is empty on purpose)", () => {
    for (const [language, entries] of [["en", english], ["fi", finnish]] as const) {
      const empty = [...entries].filter(([, text]) => text.trim() === "").map(([key]) => key);
      expect(empty, language).toEqual(["task.recording.announceIdle"]);
    }
  });

  it("uses the same placeholders in both languages", () => {
    for (const [key, text] of english) {
      expect(placeholders(finnish.get(key) ?? ""), key).toEqual(placeholders(text));
    }
  });

  it("really is translated: the Finnish text differs from the English text", () => {
    const allowedSame = new Set(["task.durationMinutesSeconds", "task.recording.announceIdle"]);
    const same = [...english].filter(([key, text]) => finnish.get(key) === text && !allowedSame.has(key)).map(([key]) => key);
    expect(same).toEqual([]);
  });

  it("covers every message key the recorder exports", () => {
    for (const dictionary of [en, fi]) {
      expect(Object.keys(dictionary.recorderErrors).sort()).toEqual([...RECORDER_MESSAGE_KEYS].sort());
      for (const key of RECORDER_MESSAGE_KEYS) expect(dictionary.recorderErrors[key].length, key).toBeGreaterThan(10);
    }
  });

  it("covers every participant error code of @dialect/domain", () => {
    for (const dictionary of [en, fi]) {
      for (const code of PARTICIPANT_ERROR_CODES) {
        expect(dictionary.errors[code].length, code).toBeGreaterThan(10);
        expect(errorMessage(dictionary, code)).toBe(dictionary.errors[code]);
      }
    }
  });

  it("provides every label of the recorder components", () => {
    for (const dictionary of [en, fi]) {
      expect(Object.keys(recordingTaskLabels(dictionary)).sort()).toEqual(Object.keys(DEFAULT_RECORDING_TASK_LABELS).sort());
      expect(Object.keys(micCheckLabels(dictionary)).sort()).toEqual(Object.keys(DEFAULT_MIC_CHECK_LABELS).sort());
    }
    // The English dictionary says the same as the defaults of the recorder components.
    expect(recordingTaskLabels(en)).toEqual(DEFAULT_RECORDING_TASK_LABELS);
    expect(micCheckLabels(en)).toEqual(DEFAULT_MIC_CHECK_LABELS);
  });

  it("follows the writing rules: no em dash, no en dash", () => {
    for (const [key, text] of [...english, ...finnish]) {
      expect(text, key).not.toMatch(new RegExp("[\\u2013\\u2014]"));
    }
  });

  it("does not prime the participant: no interface text mentions dialect or a way of speaking", () => {
    for (const [key, text] of [...english, ...finnish]) {
      expect(text, key).not.toMatch(/dialect|murre|murtee|accent|aksentti|standard|yleiskiel|kirjakiel/i);
    }
  });

  it("never names the task category in the task label", () => {
    for (const dictionary of [en, fi]) {
      expect(dictionary.task.typeLabel).not.toMatch(/controlled|semi|structured|free|kontrolloi|vapaa|strukturoi/i);
    }
  });
});

describe("pageTitle", () => {
  it("puts the step name first and the study title after it, in both languages", () => {
    expect(pageTitle(en.pageTitle.consent, "Speech study")).toBe("Consent | Speech study");
    expect(pageTitle(fi.pageTitle.consent, "Speech study")).toBe("Suostumus | Speech study");
    expect(pageTitle(format(fi.pageTitle.task, { current: 2, total: 5 }), "Speech study")).toBe("Tehtävä 2/5 | Speech study");
  });

  it("uses the step name alone when there is no study title", () => {
    expect(pageTitle(en.pageTitle.error, null)).toBe("Something went wrong");
    expect(pageTitle(en.pageTitle.welcome, "  ")).toBe("Welcome");
  });

  it("gives every step its own name", () => {
    for (const dictionary of [en, fi]) {
      const names = Object.values(dictionary.pageTitle);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("format", () => {
  it("replaces named placeholders and leaves unknown ones", () => {
    expect(format("Task {current} of {total}", { current: 2, total: 7 })).toBe("Task 2 of 7");
    expect(format("{a} and {b}", { a: "x" })).toBe("x and {b}");
    expect(format("no placeholders", {})).toBe("no placeholders");
    expect(format(fi.task.progress, { current: 2, total: 7 })).toBe("Tehtävä 2/7");
  });
});

describe("locale helpers", () => {
  it("returns the dictionary of a locale and falls back to English", () => {
    expect(getDictionary("fi")).toBe(fi);
    expect(getDictionary("fi-FI")).toBe(fi);
    expect(getDictionary("sv")).toBe(en);
    expect(getDictionary(null)).toBe(en);
  });

  it("offers only the study's locales that the interface has", () => {
    expect(availableLocales(["fi", "en"])).toEqual(["fi", "en"]);
    expect(availableLocales(["sv", "fi-FI", "fi"])).toEqual(["fi"]);
    expect(availableLocales([])).toEqual([]);
  });

  it("resolves the choice, then the study default, then the first study locale", () => {
    expect(resolveLocale("en", ["fi", "en"], "fi")).toBe("en");
    expect(resolveLocale(undefined, ["fi", "en"], "fi")).toBe("fi");
    expect(resolveLocale("en", ["fi"], "fi")).toBe("fi");
    expect(resolveLocale("constructor", ["fi", "en"], "en")).toBe("en");
    expect(resolveLocale(null, ["en"], "sv")).toBe("en");
    expect(resolveLocale(null, [], null)).toBe("en");
    // The values a session can store are accepted by the session schema.
    expect(sessionSchemas.localeSchema.safeParse(resolveLocale("fi", ["fi", "en"], "fi")).success).toBe(true);
  });

  it("maps unknown error codes to the general message", () => {
    expect(errorMessageKey("SESSION_EXPIRED")).toBe("SESSION_EXPIRED");
    expect(errorMessageKey("ASR_PROVIDER_ERROR")).toBe("UNEXPECTED");
    expect(errorMessageKey(undefined)).toBe("UNEXPECTED");
    expect(errorMessage(fi, "NETWORK_ERROR")).toBe(fi.errors.NETWORK_ERROR);
  });

  it("writes a suggested duration in words", () => {
    expect(durationText(en, 30)).toBe("30 seconds");
    expect(durationText(en, 60)).toBe("1 minute");
    expect(durationText(en, 120)).toBe("2 minutes");
    expect(durationText(en, 90)).toBe("1 min 30 s");
    expect(durationText(fi, 30)).toBe("30 sekuntia");
    expect(durationText(fi, 120)).toBe("2 minuuttia");
  });
});
