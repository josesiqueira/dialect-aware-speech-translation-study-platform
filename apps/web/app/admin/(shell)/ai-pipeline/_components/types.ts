// Types of the AI Pipeline page. The data shapes are the API response types
// shared with the server through @dialect/domain.
import type { aiConfigSchemas } from "@dialect/domain";

export type PromptVersion = aiConfigSchemas.PromptVersionDto;
export type ModelConfig = aiConfigSchemas.ModelConfigDto;
export type ProviderStatus = aiConfigSchemas.ProviderStatusDto;
export type PromptDiff = aiConfigSchemas.PromptDiffDto;
export type ConfigDiff = aiConfigSchemas.ConfigDiffDto;
export type DiffPart = aiConfigSchemas.DiffPartDto;
export type FieldChange = aiConfigSchemas.FieldChangeDto;

export type Stage = PromptVersion["stage"];

// One section of the page: a prompt key and the model config key that uses it.
export type SectionDefinition = {
  id: string;
  title: string;
  description: string;
  stage: Stage;
  promptKey: string;
  configKey: string;
  conditionKey: string | null;
  // Label of the prompt text in this section (spec 50).
  promptLabel: string;
};

// What every block needs from the page.
export type PageContext = {
  timeZone: string;
  providers: ProviderStatus[];
  outputFormats: readonly string[];
  // Reloads prompts and configs from the server.
  reload: () => Promise<void>;
  // Tells the page whether a block has unsaved edits (spec 129).
  setDirty: (blockId: string, dirty: boolean) => void;
};
