// Helpers shared by the processing tests. Not exported from the package.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  MockSpeechSynthesizer,
  MockTranscriber,
  MockTranslator,
  createProviderRegistry,
  type ProviderDefinition,
  type ProviderRegistry,
  type SynthesisInput,
  type TranscriptionInput,
  type TranslationInput,
} from "@dialect/ai";
import {
  aiPromptVersions,
  modelConfigs,
  type ModelConfigSnapshot,
  type ModelParameters,
  type sessions,
  type utterances,
} from "@dialect/db";
import {
  insertActiveAiConfigs,
  insertPublishedProtocol,
  insertSessionWithUtterance,
  insertStudy,
  insertTranscriptWithRevision,
  type ActiveAiConfigs,
  type CollectedSession,
  type ProtocolTaskRow,
  type ProtocolVersionRow,
  type StudyRow,
  type TranscriptRevisionRow,
} from "@dialect/db/testing-builders";
import type { ProcessingStage, SessionStatus, StudyMode, TranscriptType } from "@dialect/domain";
import { generateSineWav } from "@dialect/storage";
import type { ServiceContext } from "../context";
import { processOneJob } from "../jobs/worker";
import type { TestServiceContext } from "../testing";
import { loadModelConfigSnapshot } from "./config";
import { jobHandlers } from "./handlers";

// Research data is never processed with the provider named "mock" (see
// assertProviderAllowedForMode in steps.ts). Tests that process research data
// therefore use this provider: the same deterministic adapters, registered
// under another name through `extraProviders`, the way a deployment would add
// a real provider. It exists in tests only.
export const RESEARCH_TEST_PROVIDER = "test-provider";

function researchTestProviderDefinition(): ProviderDefinition {
  // One instance per registry, so "fail N times, then succeed" keeps its count.
  const transcriber = new MockTranscriber();
  const translator = new MockTranslator();
  const synthesizer = new MockSpeechSynthesizer();
  return {
    name: RESEARCH_TEST_PROVIDER,
    isConfigured: () => true,
    transcriber: () => transcriber,
    translator: () => translator,
    synthesizer: () => synthesizer,
  };
}

// Gives the test context a registry that also knows RESEARCH_TEST_PROVIDER.
// Safe to call more than once.
export function useResearchTestProvider(t: TestServiceContext): void {
  if (t.ctx.providers.listProviders().includes(RESEARCH_TEST_PROVIDER)) return;
  const providers = createProviderRegistry({ allowMock: true, extraProviders: [researchTestProviderDefinition()] });
  t.ctx.providers = providers;
  t.adminCtx.providers = providers;
}

export type TestEnv = {
  t: TestServiceContext;
  // Provider of the configurations of this study. Not set: the mock provider.
  provider?: string;
  study: StudyRow;
  protocol: ProtocolVersionRow;
  tasks: ProtocolTaskRow[];
  ai: ActiveAiConfigs;
};

// A study with source and target language, a published protocol and the four
// active configurations. `configs: false` leaves the AI configuration out.
// The configurations use the mock provider, which only test and demo data may
// use. Tests that process research data call setupResearchEnv instead.
export async function setupEnv(
  t: TestServiceContext,
  options: { configs?: boolean; provider?: string } = {},
): Promise<TestEnv> {
  useResearchTestProvider(t);
  const provider = options.provider ?? "mock";
  const study = await insertStudy(t.testDb.db, { settingsJson: { sourceLanguage: "fi", targetLanguage: "en" } });
  const { protocol, tasks } = await insertPublishedProtocol(t.testDb.db, { studyId: study.id });
  const ai =
    options.configs === false
      ? ({} as ActiveAiConfigs)
      : await insertActiveAiConfigs(t.testDb.db, { studyId: study.id, provider });
  return { t, provider, study, protocol, tasks, ai };
}

// The same study with configurations that may process research data.
export async function setupResearchEnv(t: TestServiceContext, options: { configs?: boolean } = {}): Promise<TestEnv> {
  return setupEnv(t, { ...options, provider: RESEARCH_TEST_PROVIDER });
}

export type TranscriptSpec = { text: string; verified?: boolean };

export type TestUtterance = CollectedSession & {
  audio: Buffer;
  revisions: Partial<Record<TranscriptType, TranscriptRevisionRow>>;
};

let toneCounter = 0;

// One session with one submitted utterance whose audio really is in storage.
// Every utterance gets a different tone, so the mock ASR text differs.
export async function addUtterance(
  env: TestEnv,
  options: {
    mode?: StudyMode;
    sessionStatus?: SessionStatus;
    session?: Partial<typeof sessions.$inferInsert>;
    utterance?: Partial<typeof utterances.$inferInsert>;
    transcripts?: Partial<Record<TranscriptType, TranscriptSpec>>;
  } = {},
): Promise<TestUtterance> {
  toneCounter += 1;
  const audio = generateSineWav({ durationMs: 200, sampleRateHz: 16000, frequencyHz: 200 + toneCounter * 3 });
  const assetId = randomUUID();
  const key = `test-audio/${assetId}.wav`;
  const stored = await env.t.storage.put({ key, body: audio, contentType: "audio/wav" });
  const collected = await insertSessionWithUtterance(env.t.testDb.db, {
    studyId: env.study.id,
    protocolVersionId: env.protocol.id,
    session: {
      mode: options.mode ?? "research",
      status: options.sessionStatus ?? "completed",
      completedAt: new Date(),
      ...options.session,
    },
    utterance: options.utterance,
    media: {
      id: assetId,
      storageKey: key,
      storageDriver: stored.driver,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      sampleRateHz: 16000,
      durationMs: 200,
    },
  });
  const revisions: Partial<Record<TranscriptType, TranscriptRevisionRow>> = {};
  for (const [type, spec] of Object.entries(options.transcripts ?? {}) as Array<[TranscriptType, TranscriptSpec]>) {
    const { revision } = await insertTranscriptWithRevision(env.t.testDb.db, {
      utteranceId: collected.utterance.id,
      type,
      text: spec.text,
      status: spec.verified ? "verified" : "draft",
      revision: spec.verified ? { verifiedAt: new Date(), verifiedByLabel: "JS" } : {},
    });
    revisions[type] = revision;
  }
  return { ...collected, audio, revisions };
}

// Inserts an active prompt version (optional) and an active model configuration
// with its own key, for example a translation configuration that fails.
export async function insertConfig(
  env: TestEnv,
  values: {
    key: string;
    stage: ProcessingStage;
    conditionKey?: string | null;
    modelId?: string;
    parameters?: ModelParameters;
    promptText?: string | null;
    promptVersionId?: string | null;
    versionNumber?: number;
    // Default: the provider of the study's configurations.
    provider?: string;
  },
): Promise<ModelConfigSnapshot> {
  const db = env.t.testDb.db;
  let promptVersionId = values.promptVersionId ?? null;
  if (values.promptText !== undefined && values.promptText !== null) {
    const [prompt] = await db
      .insert(aiPromptVersions)
      .values({
        studyId: env.study.id,
        key: `${values.key}_prompt`,
        stage: values.stage,
        conditionKey: values.conditionKey ?? null,
        versionNumber: values.versionNumber ?? 1,
        status: "active",
        activatedAt: new Date(),
        name: `${values.key} prompt`,
        promptText: values.promptText,
      })
      .returning();
    promptVersionId = prompt!.id;
  }
  const [config] = await db
    .insert(modelConfigs)
    .values({
      studyId: env.study.id,
      key: values.key,
      stage: values.stage,
      conditionKey: values.conditionKey ?? null,
      versionNumber: values.versionNumber ?? 1,
      status: "active",
      activatedAt: new Date(),
      provider: values.provider ?? env.provider ?? "mock",
      modelId: values.modelId ?? `mock-${values.stage}`,
      parametersJson: values.parameters ?? {},
      promptVersionId,
    })
    .returning();
  return snapshotOf(env, config!.id, values.stage);
}

export async function snapshotOf(env: TestEnv, modelConfigId: string, stage: ProcessingStage) {
  return loadModelConfigSnapshot(env.t.testDb.db, {
    modelConfigId,
    studyId: env.study.id,
    stage,
    requireActive: false,
  });
}

export async function retireConfig(env: TestEnv, modelConfigId: string): Promise<void> {
  await env.t.testDb.db
    .update(modelConfigs)
    .set({ status: "retired", retiredAt: new Date() })
    .where(eq(modelConfigs.id, modelConfigId));
}

// Runs queued jobs with the real handlers until none is available.
export async function drain(ctx: ServiceContext, limit = 1000): Promise<number> {
  let processed = 0;
  for (;;) {
    const result = await processOneJob({ deps: { ctx }, handlers: jobHandlers, workerId: "test-worker" });
    if (result === "idle") return processed;
    processed += 1;
    if (processed > limit) throw new Error("drain did not finish");
  }
}

export type ProviderCalls = {
  asr: TranscriptionInput[];
  translation: TranslationInput[];
  tts: SynthesisInput[];
};

// A registry that records exactly what each adapter receives, then calls the
// real mock adapter.
export function recordingProviders(inner: ProviderRegistry): { providers: ProviderRegistry; calls: ProviderCalls } {
  const calls: ProviderCalls = { asr: [], translation: [], tts: [] };
  const providers: ProviderRegistry = {
    ...inner,
    transcriber: (provider) => ({
      transcribe: async (input) => {
        calls.asr.push(input);
        return inner.transcriber(provider).transcribe(input);
      },
    }),
    translator: (provider) => ({
      translate: async (input) => {
        calls.translation.push(input);
        return inner.translator(provider).translate(input);
      },
    }),
    synthesizer: (provider) => ({
      synthesize: async (input) => {
        calls.tts.push(input);
        return inner.synthesizer(provider).synthesize(input);
      },
    }),
  };
  return { providers, calls };
}
