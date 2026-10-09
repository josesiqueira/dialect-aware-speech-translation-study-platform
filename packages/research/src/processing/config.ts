// Model configuration snapshots (spec 28, 54, 143).
//
// A snapshot is a frozen copy of one model_configs row together with the text of
// its prompt version. The pipeline steps only ever read a snapshot, so a batch
// keeps using exactly the configuration it was created with, whatever is
// activated or retired afterwards.
import { and, eq } from "drizzle-orm";
import {
  aiPromptVersions,
  modelConfigs,
  type studies,
  type DbOrTx,
  type ModelConfigSnapshot,
} from "@dialect/db";
import { AppError, type ProcessingStage } from "@dialect/domain";

export type ModelConfigRow = typeof modelConfigs.$inferSelect;
export type StudyRow = typeof studies.$inferSelect;

async function toSnapshot(db: DbOrTx, config: ModelConfigRow): Promise<ModelConfigSnapshot> {
  let prompt: typeof aiPromptVersions.$inferSelect | undefined;
  if (config.promptVersionId) {
    [prompt] = await db
      .select()
      .from(aiPromptVersions)
      .where(eq(aiPromptVersions.id, config.promptVersionId))
      .limit(1);
  }
  return {
    modelConfigId: config.id,
    key: config.key,
    stage: config.stage,
    conditionKey: config.conditionKey,
    versionNumber: config.versionNumber,
    provider: config.provider,
    modelId: config.modelId,
    parameters: config.parametersJson ?? {},
    promptVersionId: prompt?.id ?? null,
    promptKey: prompt?.key ?? null,
    promptVersionNumber: prompt?.versionNumber ?? null,
    promptText: prompt?.promptText ?? null,
  };
}

// Snapshot of the active configuration with this key. There is no fallback: when
// no version is active the caller gets CONFIGURATION_MISSING (spec 143).
export async function loadActiveModelConfigSnapshot(
  db: DbOrTx,
  input: { studyId: string; key: string; stage: ProcessingStage },
): Promise<ModelConfigSnapshot> {
  const [config] = await db
    .select()
    .from(modelConfigs)
    .where(
      and(eq(modelConfigs.studyId, input.studyId), eq(modelConfigs.key, input.key), eq(modelConfigs.status, "active")),
    )
    .limit(1);
  if (!config) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `No active model configuration "${input.key}" exists. Activate one on the AI Pipeline page first.`,
      { key: input.key, stage: input.stage },
    );
  }
  if (config.stage !== input.stage) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `The active model configuration "${input.key}" is for the ${config.stage} stage, not for ${input.stage}.`,
      { key: input.key, stage: input.stage },
    );
  }
  return toSnapshot(db, config);
}

// Snapshot of one configuration chosen by id. `requireActive` is used when a
// batch is created: only an active configuration can be selected for new work.
export async function loadModelConfigSnapshot(
  db: DbOrTx,
  input: { modelConfigId: string; studyId: string; stage: ProcessingStage; requireActive: boolean },
): Promise<ModelConfigSnapshot> {
  const [config] = await db.select().from(modelConfigs).where(eq(modelConfigs.id, input.modelConfigId)).limit(1);
  if (!config || config.studyId !== input.studyId) {
    throw new AppError("CONFIGURATION_MISSING", "The selected model configuration does not exist.", {
      modelConfigId: input.modelConfigId,
      stage: input.stage,
    });
  }
  if (config.stage !== input.stage) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `The model configuration "${config.key}" version ${config.versionNumber} is for the ${config.stage} stage, not for ${input.stage}.`,
      { modelConfigId: config.id, stage: input.stage },
    );
  }
  if (config.status === "draft" || (input.requireActive && config.status !== "active")) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `The model configuration "${config.key}" version ${config.versionNumber} is ${config.status}, not active. Activate it on the AI Pipeline page first.`,
      { modelConfigId: config.id, status: config.status },
    );
  }
  return toSnapshot(db, config);
}

// The study a service call works on. The platform holds one study, so the id
// may be left out: the study created first is used, as in every other area.
// The shared implementation is in ../study.ts.
export { resolveStudy } from "../study";
