// Stored model configurations for the mock provider (docs/DEMO-MODE.md, "Mock provider").
//
// The mock option of Demo Mode, the mock option of the pipeline test and the
// sample TEST sessions of the development seed all need model configurations
// whose provider is `mock`. They must not touch the active configurations, and
// every model run must still point at a real, unchangeable configuration row
// (model_runs.model_config_id), so that provenance is complete.
//
// Choice: four configurations under reserved keys, inserted directly with the
// status `retired`.
// - A retired row is immutable (database trigger) and can never become active,
//   so it can never be picked up by a research batch or by automatic ASR.
// - A draft would be editable and deletable, which is wrong for a row that model
//   runs point at, and the pipeline steps refuse drafts.
// - A snapshot that exists only in memory would leave model_config_id pointing
//   at nothing.
// The rows are created on first use and reused afterwards.
import { and, eq, inArray } from "drizzle-orm";
import { MOCK_PROVIDER } from "@dialect/ai";
import {
  aiPromptVersions,
  isUniqueViolation,
  modelConfigs,
  type ModelConfigSnapshot,
  type ModelParameters,
} from "@dialect/db";
import { AppError, TTS_BASELINE_CONDITION, type ProcessingStage } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { loadModelConfigSnapshot } from "../processing/config";

export const MOCK_CONFIG_KEYS = {
  asr: "mock_asr",
  translationDefault: "mock_translation_default",
  translationPreserve: "mock_translation_preserve",
  tts: "mock_tts",
} as const;

const MOCK_LABEL = "MOCK PROVIDER, not real model output";

type MockDefinition = {
  key: string;
  stage: ProcessingStage;
  conditionKey: string | null;
  name: string;
  modelId: string;
  parameters: ModelParameters;
  promptText: string | null;
};

const DEFINITIONS: MockDefinition[] = [
  {
    key: MOCK_CONFIG_KEYS.asr,
    stage: "asr",
    conditionKey: null,
    name: `Mock ASR (${MOCK_LABEL})`,
    modelId: "mock-asr",
    parameters: { language: "fi" },
    promptText: null,
  },
  {
    key: MOCK_CONFIG_KEYS.translationDefault,
    stage: "translation",
    conditionKey: "default",
    name: `Mock default translation (${MOCK_LABEL})`,
    modelId: "mock-translation",
    parameters: {},
    promptText: "Mock default translation instruction. Translate from {{source_language}} to {{target_language}}.",
  },
  {
    key: MOCK_CONFIG_KEYS.translationPreserve,
    stage: "translation",
    conditionKey: "preservation",
    name: `Mock preservation translation (${MOCK_LABEL})`,
    modelId: "mock-translation",
    parameters: {},
    promptText:
      "Mock preservation translation instruction. Translate from {{source_language}} to {{target_language}} and keep the variation.",
  },
  {
    key: MOCK_CONFIG_KEYS.tts,
    stage: "tts",
    conditionKey: TTS_BASELINE_CONDITION,
    name: `Mock TTS (${MOCK_LABEL})`,
    modelId: "mock-tts",
    parameters: { voice: "mock-voice", response_format: "wav" },
    promptText: null,
  },
];

export type MockPipelineConfigs = {
  asr: ModelConfigSnapshot;
  translationDefault: ModelConfigSnapshot;
  translationPreserve: ModelConfigSnapshot;
  tts: ModelConfigSnapshot;
};

// True when this server offers the mock provider (AI_ALLOW_MOCK_PROVIDER).
export function mockProviderAvailable(ctx: ServiceContext): boolean {
  return ctx.providers.listProviders().includes(MOCK_PROVIDER);
}

async function ensureOne(ctx: ServiceContext, studyId: string, definition: MockDefinition): Promise<string> {
  const find = async () => {
    const [row] = await ctx.db
      .select({ id: modelConfigs.id, provider: modelConfigs.provider, status: modelConfigs.status })
      .from(modelConfigs)
      .where(
        and(
          eq(modelConfigs.studyId, studyId),
          eq(modelConfigs.key, definition.key),
          eq(modelConfigs.provider, MOCK_PROVIDER),
          inArray(modelConfigs.status, ["retired"]),
        ),
      )
      .orderBy(modelConfigs.versionNumber)
      .limit(1);
    return row?.id ?? null;
  };
  const existing = await find();
  if (existing) return existing;

  const now = ctx.now();
  try {
    return await ctx.db.transaction(async (tx) => {
      let promptVersionId: string | null = null;
      if (definition.promptText !== null) {
        const [prompt] = await tx
          .insert(aiPromptVersions)
          .values({
            studyId,
            key: definition.key,
            stage: definition.stage,
            conditionKey: definition.conditionKey,
            versionNumber: 1,
            status: "retired",
            retiredAt: now,
            name: definition.name,
            promptText: definition.promptText,
            notes: "Created automatically for the mock provider option. Never active.",
            createdByLabel: "system",
          })
          .returning({ id: aiPromptVersions.id });
        if (!prompt) throw new AppError("DATABASE_ERROR", "The mock prompt version could not be stored.");
        promptVersionId = prompt.id;
      }
      const [config] = await tx
        .insert(modelConfigs)
        .values({
          studyId,
          key: definition.key,
          stage: definition.stage,
          conditionKey: definition.conditionKey,
          versionNumber: 1,
          status: "retired",
          retiredAt: now,
          name: definition.name,
          provider: MOCK_PROVIDER,
          modelId: definition.modelId,
          parametersJson: definition.parameters,
          promptVersionId,
          notes: "Created automatically for the mock provider option. Never active.",
          createdByLabel: "system",
        })
        .returning({ id: modelConfigs.id });
      if (!config) throw new AppError("DATABASE_ERROR", "The mock model configuration could not be stored.");
      return config.id;
    });
  } catch (error) {
    // Two requests created the rows at the same moment: use the stored ones.
    if (isUniqueViolation(error)) {
      const again = await find();
      if (again) return again;
      throw new AppError(
        "CONFLICT",
        `The configuration key "${definition.key}" is reserved for the mock provider but is used by another configuration.`,
        { key: definition.key },
      );
    }
    throw error;
  }
}

// Returns the four mock configurations of the study, creating them when they do
// not exist yet. Throws CONFIGURATION_MISSING when the mock provider is disabled.
export async function ensureMockPipelineConfigs(ctx: ServiceContext, studyId: string): Promise<MockPipelineConfigs> {
  if (!mockProviderAvailable(ctx)) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      "The mock AI provider is disabled on this server. It is only available for tests and local development.",
      { provider: MOCK_PROVIDER },
    );
  }
  const snapshots: ModelConfigSnapshot[] = [];
  for (const definition of DEFINITIONS) {
    const id = await ensureOne(ctx, studyId, definition);
    snapshots.push(
      await loadModelConfigSnapshot(ctx.db, {
        modelConfigId: id,
        studyId,
        stage: definition.stage,
        requireActive: false,
      }),
    );
  }
  const [asr, translationDefault, translationPreserve, tts] = snapshots as [
    ModelConfigSnapshot,
    ModelConfigSnapshot,
    ModelConfigSnapshot,
    ModelConfigSnapshot,
  ];
  return { asr, translationDefault, translationPreserve, tts };
}
