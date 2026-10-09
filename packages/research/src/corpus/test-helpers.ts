// Builders shared by the corpus service tests. Not exported from the package.
import type { Database } from "@dialect/db";
import {
  emptyBatchSnapshot,
  insertActiveAiConfigs,
  insertProcessingBatch,
  insertSynthesis,
  insertTranscriptWithRevision,
  insertTranslation,
  type ActiveAiConfigs,
  type ModelConfigRow,
} from "@dialect/db/testing-builders";
import type { ModelConfigSnapshot } from "@dialect/db";

function snapshotOf(config: ModelConfigRow, promptKey: string): ModelConfigSnapshot {
  return {
    modelConfigId: config.id,
    key: config.key,
    stage: config.stage,
    conditionKey: config.conditionKey,
    versionNumber: config.versionNumber,
    provider: config.provider,
    modelId: config.modelId,
    parameters: config.parametersJson,
    promptVersionId: config.promptVersionId,
    promptKey,
    promptVersionNumber: 1,
    promptText: null,
  };
}

export type ProcessedUtterance = Awaited<ReturnType<typeof processUtterance>>;

// Adds the four transcripts (A from a model run, B and C verified), and for each
// given batch name the translations of A, B and C under both conditions with one
// synthesis each. Returns the inserted rows.
export async function processUtterance(
  db: Database,
  input: {
    studyId: string;
    utteranceId: string;
    ai?: ActiveAiConfigs;
    batchNames?: string[];
    dataMode?: "research" | "demo" | "test";
    verified?: boolean;
  },
) {
  const ai = input.ai ?? (await insertActiveAiConfigs(db, { studyId: input.studyId }));
  const verifiedAt = new Date("2026-10-02T10:00:00.000Z");
  const verified = input.verified ?? true;

  const asr = await insertTranscriptWithRevision(db, {
    utteranceId: input.utteranceId,
    type: "asr",
    status: "draft",
    text: "mie en oikeestaan tiia",
  });
  const dialect = await insertTranscriptWithRevision(db, {
    utteranceId: input.utteranceId,
    type: "human_dialect",
    status: verified ? "verified" : "draft",
    text: "Mie en oikeestaan tiiä.",
    revision: verified
      ? { verifiedAt, verifiedByLabel: "JS", transcriptionConventionVersion: "1.0" }
      : {},
  });
  const normalized = await insertTranscriptWithRevision(db, {
    utteranceId: input.utteranceId,
    type: "normalized",
    status: verified ? "verified" : "draft",
    text: "Minä en oikeastaan tiedä.",
    revision: verified ? { verifiedAt, verifiedByLabel: "JS", derivedFromRevisionId: dialect.revision.id } : {},
  });

  const batches = [];
  for (const name of input.batchNames ?? []) {
    const batch = await insertProcessingBatch(db, {
      studyId: input.studyId,
      name,
      status: "completed",
      dataMode: input.dataMode ?? "research",
      startedAt: new Date("2026-10-02T11:00:00.000Z"),
      completedAt: new Date("2026-10-02T11:05:00.000Z"),
      configurationSnapshotJson: emptyBatchSnapshot({
        transcriptTypes: ["asr", "human_dialect", "normalized"],
        translations: [
          snapshotOf(ai.configs.translationDefault, "translation_default"),
          snapshotOf(ai.configs.translationPreserve, "translation_preserve"),
        ],
        tts: [snapshotOf(ai.configs.ttsBaseline, "tts_baseline")],
        utteranceIds: [input.utteranceId],
      }),
    });
    const outputs = [];
    for (const source of [asr, dialect, normalized]) {
      for (const condition of ["default", "preservation"] as const) {
        const config = condition === "default" ? ai.configs.translationDefault : ai.configs.translationPreserve;
        const translation = await insertTranslation(db, {
          sourceTranscriptRevisionId: source.revision.id,
          processingBatchId: batch.id,
          conditionKey: condition,
          translatedText: `${name} ${source.transcript.type} ${condition}`,
          modelRun: {
            modelConfigId: config.id,
            promptVersionId: config.promptVersionId,
            appVersion: "1.2.3",
            gitCommitSha: "abc1234",
          },
        });
        const synthesis = await insertSynthesis(db, {
          studyId: input.studyId,
          translationId: translation.translation.id,
          processingBatchId: batch.id,
          conditionKey: "baseline",
          sourceText: translation.translation.translatedText,
          modelRun: {
            modelConfigId: ai.configs.ttsBaseline.id,
            promptVersionId: ai.configs.ttsBaseline.promptVersionId,
            appVersion: "1.2.3",
          },
        });
        outputs.push({ sourceType: source.transcript.type, condition, ...translation, synthesis });
      }
    }
    batches.push({ batch, outputs });
  }

  return { ai, asr, dialect, normalized, batches };
}
