import { describe, expect, it } from "vitest";
import { MOCK_CONFIG_KEYS as SERVER_MOCK_CONFIG_KEYS } from "../../../../../../../packages/research/src/demo/mock-configs";
import { experimentalSections, MOCK_CONFIG_KEYS, MOCK_GROUP_TITLE, mockSections, STANDARD_SECTIONS } from "./sections";
import type { ModelConfig, PromptVersion } from "./types";

// Mock data: only the fields the section builders read.
function config(key: string, stage: ModelConfig["stage"], conditionKey: string | null, promptKey?: string): ModelConfig {
  return { key, stage, conditionKey, prompt: promptKey ? { key: promptKey } : null } as unknown as ModelConfig;
}
function prompt(key: string, stage: PromptVersion["stage"], conditionKey: string | null): PromptVersion {
  return { key, stage, conditionKey } as unknown as PromptVersion;
}

const CONFIGS: ModelConfig[] = [
  ...STANDARD_SECTIONS.map((section) => config(section.configKey, section.stage, section.conditionKey, section.promptKey)),
  config("mock_asr", "asr", null),
  config("mock_translation_default", "translation", "default", "mock_translation_default"),
  config("mock_translation_preserve", "translation", "preservation", "mock_translation_preserve"),
  config("mock_tts", "tts", "baseline"),
  config("translation_formal_register", "translation", "formal_register", "translation_formal_register"),
];
const PROMPTS: PromptVersion[] = [
  ...STANDARD_SECTIONS.map((section) => prompt(section.promptKey, section.stage, section.conditionKey)),
  prompt("mock_translation_default", "translation", "default"),
  prompt("mock_translation_preserve", "translation", "preservation"),
  prompt("translation_formal_register", "translation", "formal_register"),
  prompt("tts_slow", "tts", "slow"),
];

describe("AI Pipeline sections", () => {
  it("uses the reserved mock keys of the server", () => {
    expect([...MOCK_CONFIG_KEYS].sort()).toEqual(Object.values(SERVER_MOCK_CONFIG_KEYS).sort());
    expect(MOCK_GROUP_TITLE).toBe("Mock provider configurations (development and plumbing tests only)");
  });

  it("keeps the mock provider configurations out of the experimental conditions", () => {
    const sections = experimentalSections(PROMPTS, CONFIGS);
    expect(sections.map((section) => [section.id, section.configKey, section.promptKey])).toEqual([
      ["experimental:translation_formal_register", "translation_formal_register", "translation_formal_register"],
      ["experimental:tts_slow", "tts_slow", "tts_slow"],
    ]);
    expect(sections.every((section) => section.description === "Experimental condition added by a researcher.")).toBe(true);
  });

  it("lists the mock provider configurations in their own group, not described as added by a researcher", () => {
    const sections = mockSections(PROMPTS, CONFIGS);
    expect(sections.map((section) => [section.id, section.title, section.promptKey])).toEqual([
      ["mock:mock_asr", "ASR: mock_asr", "mock_asr"],
      ["mock:mock_translation_default", "Translation: mock_translation_default", "mock_translation_default"],
      ["mock:mock_translation_preserve", "Translation: mock_translation_preserve", "mock_translation_preserve"],
      ["mock:mock_tts", "TTS: mock_tts", "mock_tts"],
    ]);
    for (const section of sections) {
      expect(section.description).toContain("mock provider");
      expect(section.description).not.toContain("researcher");
    }
  });

  it("returns no mock group when the database has no mock configuration", () => {
    expect(mockSections(PROMPTS.filter((row) => !row.key.startsWith("mock_")), CONFIGS.filter((row) => !row.key.startsWith("mock_")))).toEqual([]);
  });
});
