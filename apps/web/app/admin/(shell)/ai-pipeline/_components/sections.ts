// The sections of the AI Pipeline page (spec 50). The four standard sections
// use the keys the processing code reads. The four reserved keys of the mock
// provider are shown in their own group, "Mock provider configurations".
// Every other key found in the database is shown under "Optional experimental
// conditions".
import type { ModelConfig, PromptVersion, SectionDefinition, Stage } from "./types";

export const STANDARD_SECTIONS: SectionDefinition[] = [
  {
    id: "asr",
    title: "ASR",
    description: "Speech recognition of the source recordings (transcript A).",
    stage: "asr",
    promptKey: "asr_context",
    configKey: "asr_default",
    conditionKey: null,
    promptLabel: "Context prompt",
  },
  {
    id: "translation_default",
    title: "Translation: Default",
    description: "The deliberately ordinary translation instruction.",
    stage: "translation",
    promptKey: "translation_default",
    configKey: "translation_default",
    conditionKey: "default",
    promptLabel: "Instruction text",
  },
  {
    id: "translation_preserve",
    title: "Translation: Preservation",
    description: "The preservation-aware translation instruction.",
    stage: "translation",
    promptKey: "translation_preserve",
    configKey: "translation_preserve",
    conditionKey: "preservation",
    promptLabel: "Instruction text",
  },
  {
    id: "tts_baseline",
    title: "TTS: Baseline",
    description: "Speech synthesis of the translated text.",
    stage: "tts",
    promptKey: "tts_baseline",
    configKey: "tts_baseline",
    conditionKey: "baseline",
    promptLabel: "Instructions",
  },
];

export const STAGE_LABELS: Record<Stage, string> = {
  asr: "ASR",
  translation: "Translation",
  tts: "TTS",
  realtime_translation: "Realtime translation",
};

export function promptLabelForStage(stage: Stage): string {
  if (stage === "asr") return "Context prompt";
  if (stage === "tts") return "Instructions";
  return "Instruction text";
}

// The reserved keys of the stored mock provider configurations. The server
// creates them on first use of the mock option (Demo Mode, pipeline test,
// sample sessions) with the status "retired", so they can never become active.
// Same values as MOCK_CONFIG_KEYS in packages/research/src/demo/mock-configs.ts
// (sections.test.ts checks that the two lists stay equal).
export const MOCK_CONFIG_KEYS: readonly string[] = [
  "mock_asr",
  "mock_translation_default",
  "mock_translation_preserve",
  "mock_tts",
];

export const MOCK_GROUP_TITLE = "Mock provider configurations (development and plumbing tests only)";

const isMockKey = (key: string) => MOCK_CONFIG_KEYS.includes(key);

// Sections for the prompt keys and config keys outside the standard four that
// `include` accepts.
function otherSections(
  prompts: PromptVersion[],
  configs: ModelConfig[],
  options: { include: (key: string) => boolean; idPrefix: string; description: string },
): SectionDefinition[] {
  const standardPromptKeys = new Set(STANDARD_SECTIONS.map((section) => section.promptKey));
  const standardConfigKeys = new Set(STANDARD_SECTIONS.map((section) => section.configKey));
  const sections: SectionDefinition[] = [];
  const usedPromptKeys = new Set<string>();

  const describe = (stage: Stage, key: string, promptKey: string, conditionKey: string | null): SectionDefinition => ({
    id: `${options.idPrefix}:${key}`,
    title: `${STAGE_LABELS[stage]}: ${conditionKey ?? key}`,
    description: options.description,
    stage,
    promptKey,
    configKey: key,
    conditionKey,
    promptLabel: promptLabelForStage(stage),
  });

  const configKeys = [...new Set(configs.map((config) => config.key))].filter(
    (key) => !standardConfigKeys.has(key) && options.include(key),
  );
  for (const key of configKeys.sort()) {
    // The list is ordered newest first, so the first row is the latest version.
    const latest = configs.find((config) => config.key === key)!;
    const linkedKey = latest.prompt?.key;
    const promptKey = linkedKey && !standardPromptKeys.has(linkedKey) ? linkedKey : key;
    usedPromptKeys.add(promptKey);
    sections.push(describe(latest.stage, key, promptKey, latest.conditionKey));
  }

  const promptKeys = [...new Set(prompts.map((prompt) => prompt.key))].filter(
    (key) => !standardPromptKeys.has(key) && !usedPromptKeys.has(key) && options.include(key),
  );
  for (const key of promptKeys.sort()) {
    const latest = prompts.find((prompt) => prompt.key === key)!;
    sections.push(describe(latest.stage, key, key, latest.conditionKey));
  }
  return sections;
}

// Conditions a researcher added: every key outside the standard four and the mock keys.
export function experimentalSections(prompts: PromptVersion[], configs: ModelConfig[]): SectionDefinition[] {
  return otherSections(prompts, configs, {
    include: (key) => !isMockKey(key),
    idPrefix: "experimental",
    description: "Experimental condition added by a researcher.",
  });
}

// The stored mock provider configurations, when they exist in the database.
export function mockSections(prompts: PromptVersion[], configs: ModelConfig[]): SectionDefinition[] {
  return otherSections(prompts, configs, {
    include: isMockKey,
    idPrefix: "mock",
    description:
      "Created automatically for the mock provider option. Its output is marked mock output, is never research data and is never used by a research batch.",
  }).map((section) => ({ ...section, title: `${STAGE_LABELS[section.stage]}: ${section.configKey}` }));
}
