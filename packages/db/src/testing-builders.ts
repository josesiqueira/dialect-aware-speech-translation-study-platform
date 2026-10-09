// Small builders that insert valid rows for tests. Every builder accepts partial
// overrides and returns the inserted rows. They respect the database triggers:
// versions are inserted as drafts, filled, then published.
//
// These builders insert database rows only. insertUtteranceWithMedia inserts the
// media metadata row, it does not write an audio file to storage.
//
// Provider and model names used here are mock values. Real model identifiers
// live only in the development seed.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "./client";
import type { BatchConfigurationSnapshot, ConsentItem } from "./json-types";
import {
  aiPromptVersions,
  consentVersions,
  mediaAssets,
  modelConfigs,
  modelRuns,
  processingBatches,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireItems,
  questionnaireVersions,
  sessionConsents,
  sessions,
  studies,
  syntheses,
  taskPresentations,
  transcriptRevisions,
  transcripts,
  translations,
  utterances,
} from "./schema";

export type StudyRow = typeof studies.$inferSelect;
export type ConsentVersionRow = typeof consentVersions.$inferSelect;
export type QuestionnaireVersionRow = typeof questionnaireVersions.$inferSelect;
export type QuestionnaireItemRow = typeof questionnaireItems.$inferSelect;
export type ProtocolVersionRow = typeof protocolVersions.$inferSelect;
export type ProtocolTaskRow = typeof protocolTasks.$inferSelect;
export type ProtocolTaskFollowupRow = typeof protocolTaskFollowups.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionConsentRow = typeof sessionConsents.$inferSelect;
export type TaskPresentationRow = typeof taskPresentations.$inferSelect;
export type UtteranceRow = typeof utterances.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;
export type TranscriptRevisionRow = typeof transcriptRevisions.$inferSelect;
export type AiPromptVersionRow = typeof aiPromptVersions.$inferSelect;
export type ModelConfigRow = typeof modelConfigs.$inferSelect;
export type ProcessingBatchRow = typeof processingBatches.$inferSelect;
export type ModelRunRow = typeof modelRuns.$inferSelect;
export type TranslationRow = typeof translations.$inferSelect;
export type SynthesisRow = typeof syntheses.$inferSelect;

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Expected the insert to return a row");
  return row;
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

// A valid lowercase hexadecimal SHA-256 for a media row that has no real file.
export function randomSha256(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

// Random pseudonymous code in the same shape as real ones, for example P-7K4M9Q.
export function randomParticipantCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `P-${code}`;
}

export async function insertStudy(
  db: DbOrTx,
  overrides: Partial<typeof studies.$inferInsert> = {},
): Promise<StudyRow> {
  return one(
    await db
      .insert(studies)
      .values({ slug: `study-${shortId()}`, name: "Test study", ...overrides })
      .returning(),
  );
}

export const DEFAULT_TEST_CONSENT_ITEMS: ConsentItem[] = [
  { id: "participation", text: "I agree to take part in this study.", required: true, scope: "participation" },
  { id: "voice_recording", text: "I agree that my voice is recorded.", required: true, scope: "voice_recording" },
  { id: "future_reuse", text: "My recordings may be reused in later research.", required: false, scope: "future_research_reuse" },
];

async function nextVersionNumber(
  db: DbOrTx,
  table: typeof consentVersions | typeof protocolVersions,
  studyId: string,
): Promise<number> {
  const rows = await db
    .select({ versionNumber: table.versionNumber })
    .from(table)
    .where(eq(table.studyId, studyId));
  return rows.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;
}

// Inserts a consent version. Published by default, pass { publishedAt: null } for a draft.
export async function insertConsentVersion(
  db: DbOrTx,
  input: { studyId: string } & Partial<typeof consentVersions.$inferInsert>,
): Promise<ConsentVersionRow> {
  return one(
    await db
      .insert(consentVersions)
      .values({
        versionNumber: input.versionNumber ?? (await nextVersionNumber(db, consentVersions, input.studyId)),
        title: "Consent to take part",
        informationText: "Test information text.",
        itemsJson: DEFAULT_TEST_CONSENT_ITEMS,
        publishedAt: new Date(),
        ...input,
      })
      .returning(),
  );
}

export type QuestionnaireItemInput = Omit<
  typeof questionnaireItems.$inferInsert,
  "questionnaireVersionId" | "orderIndex"
> & { orderIndex?: number };

export const DEFAULT_TEST_QUESTIONNAIRE_ITEMS: QuestionnaireItemInput[] = [
  {
    itemKey: "naturalness",
    type: "likert",
    prompt: "How naturally did you feel you were speaking?",
    required: true,
    configJson: { scaleMin: 1, scaleMax: 5 },
  },
  { itemKey: "comment", type: "free_text", prompt: "Any other comments?", required: false },
];

// Inserts a questionnaire version with items. The version is inserted as a draft,
// the items are added, then it is published unless status "draft" is requested.
export async function insertQuestionnaire(
  db: DbOrTx,
  input: {
    studyId: string;
    key?: string;
    status?: "draft" | "published";
    items?: QuestionnaireItemInput[];
  } & Partial<Omit<typeof questionnaireVersions.$inferInsert, "status">>,
): Promise<{ version: QuestionnaireVersionRow; items: QuestionnaireItemRow[] }> {
  const { items = DEFAULT_TEST_QUESTIONNAIRE_ITEMS, status = "published", ...versionValues } = input;
  const key = input.key ?? "background";
  const existing = await db
    .select({ versionNumber: questionnaireVersions.versionNumber, key: questionnaireVersions.key })
    .from(questionnaireVersions)
    .where(eq(questionnaireVersions.studyId, input.studyId));
  const nextNumber =
    existing.filter((row) => row.key === key).reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;
  let version = one(
    await db
      .insert(questionnaireVersions)
      .values({
        name: `Test questionnaire (${key})`,
        versionNumber: nextNumber,
        ...versionValues,
        key,
        status: "draft",
        publishedAt: null,
      })
      .returning(),
  );
  const itemRows =
    items.length === 0
      ? []
      : await db
          .insert(questionnaireItems)
          .values(
            items.map((item, index) => ({
              ...item,
              orderIndex: item.orderIndex ?? index,
              questionnaireVersionId: version.id,
            })),
          )
          .returning();
  if (status === "published") {
    version = one(
      await db
        .update(questionnaireVersions)
        .set({ status: "published", publishedAt: input.publishedAt ?? new Date() })
        .where(eq(questionnaireVersions.id, version.id))
        .returning(),
    );
  }
  return { version, items: itemRows };
}

export type ProtocolTaskInput = Partial<Omit<typeof protocolTasks.$inferInsert, "protocolVersionId">> & {
  followups?: Array<Partial<Omit<typeof protocolTaskFollowups.$inferInsert, "protocolTaskId">>>;
};

export const DEFAULT_TEST_PROTOCOL_TASKS: ProtocolTaskInput[] = [
  {
    taskKey: "controlled_1",
    taskType: "controlled",
    title: "Controlled task",
    participantPrompt: "Test prompt for a controlled task.",
    blockKey: "controlled",
    orderMode: "shuffle_within_block",
  },
  {
    taskKey: "semi_1",
    taskType: "semi_structured",
    title: "Semi-structured task",
    participantPrompt: "Test prompt for a semi-structured task.",
    blockKey: "semi_structured",
    followups: [{ followupKey: "followup_1", promptText: "Test follow-up prompt." }],
  },
];

export type ProtocolBundle = {
  protocol: ProtocolVersionRow;
  tasks: ProtocolTaskRow[];
  followups: ProtocolTaskFollowupRow[];
};

// Inserts a draft protocol version with its tasks and follow-ups.
export async function insertDraftProtocol(
  db: DbOrTx,
  input: { studyId: string; tasks?: ProtocolTaskInput[] } & Partial<
    Omit<typeof protocolVersions.$inferInsert, "status">
  >,
): Promise<ProtocolBundle> {
  const { tasks = DEFAULT_TEST_PROTOCOL_TASKS, ...protocolValues } = input;
  const blockKeys = [...new Set(tasks.map((task) => task.blockKey ?? "main"))];
  const protocol = one(
    await db
      .insert(protocolVersions)
      .values({
        versionNumber:
          input.versionNumber ?? (await nextVersionNumber(db, protocolVersions, input.studyId)),
        name: "Test protocol",
        welcomeContent: "Test welcome text.",
        informationContent: "Test information text.",
        instructionContent: "Test instruction text.",
        debriefContent: "Test debrief text.",
        orderConfigJson: {
          blocks: blockKeys.map((key) => ({
            key,
            orderMode: tasks.find((task) => (task.blockKey ?? "main") === key)?.orderMode ?? "fixed",
          })),
        },
        ...protocolValues,
        status: "draft",
        publishedAt: null,
      })
      .returning(),
  );
  const taskRows: ProtocolTaskRow[] = [];
  const followupRows: ProtocolTaskFollowupRow[] = [];
  for (const [index, taskInput] of tasks.entries()) {
    const { followups = [], ...taskValues } = taskInput;
    const task = one(
      await db
        .insert(protocolTasks)
        .values({
          taskKey: `task_${index + 1}`,
          taskType: "controlled",
          title: `Task ${index + 1}`,
          participantPrompt: `Test prompt ${index + 1}.`,
          blockKey: "main",
          orderIndex: index,
          ...taskValues,
          protocolVersionId: protocol.id,
        })
        .returning(),
    );
    taskRows.push(task);
    for (const [followupIndex, followup] of followups.entries()) {
      followupRows.push(
        one(
          await db
            .insert(protocolTaskFollowups)
            .values({
              followupKey: `followup_${followupIndex + 1}`,
              promptText: `Test follow-up ${followupIndex + 1}.`,
              orderIndex: followupIndex,
              ...followup,
              protocolTaskId: task.id,
            })
            .returning(),
        ),
      );
    }
  }
  return { protocol, tasks: taskRows, followups: followupRows };
}

// Publishes a draft protocol version. Its consent version (and questionnaires,
// if set) must already be published, otherwise the database raises INVALID_STATE.
export async function publishProtocol(
  db: DbOrTx,
  protocolVersionId: string,
  options: { publishedAt?: Date; setAsCurrent?: boolean } = {},
): Promise<ProtocolVersionRow> {
  const protocol = one(
    await db
      .update(protocolVersions)
      .set({ status: "published", publishedAt: options.publishedAt ?? new Date() })
      .where(eq(protocolVersions.id, protocolVersionId))
      .returning(),
  );
  if (options.setAsCurrent ?? true) {
    await db
      .update(studies)
      .set({ currentProtocolVersionId: protocol.id })
      .where(eq(studies.id, protocol.studyId));
  }
  return protocol;
}

// Inserts a published protocol version with tasks. Creates a published consent
// version when consentVersionId is not given. By default it becomes the study's
// current protocol (setAsCurrent: false turns that off).
export async function insertPublishedProtocol(
  db: DbOrTx,
  input: { studyId: string; tasks?: ProtocolTaskInput[]; setAsCurrent?: boolean } & Partial<
    Omit<typeof protocolVersions.$inferInsert, "status">
  >,
): Promise<ProtocolBundle & { consent: ConsentVersionRow }> {
  const { setAsCurrent, publishedAt, ...draftInput } = input;
  const consent = input.consentVersionId
    ? one(await db.select().from(consentVersions).where(eq(consentVersions.id, input.consentVersionId)))
    : await insertConsentVersion(db, { studyId: input.studyId });
  const draft = await insertDraftProtocol(db, { ...draftInput, consentVersionId: consent.id });
  const protocol = await publishProtocol(db, draft.protocol.id, {
    publishedAt: publishedAt ?? undefined,
    setAsCurrent,
  });
  return { ...draft, protocol, consent };
}

// Inserts a session. The default mode is "research".
export async function insertSession(
  db: DbOrTx,
  input: { studyId: string; protocolVersionId: string } & Partial<typeof sessions.$inferInsert>,
): Promise<SessionRow> {
  return one(
    await db
      .insert(sessions)
      .values({
        participantCode: randomParticipantCode(),
        mode: "research",
        appVersion: "test",
        ...input,
      })
      .returning(),
  );
}

// Stores acceptance of every item of the consent version, unless responsesJson is given.
export async function insertSessionConsent(
  db: DbOrTx,
  input: { sessionId: string; consentVersionId: string } & Partial<typeof sessionConsents.$inferInsert>,
): Promise<SessionConsentRow> {
  let responsesJson = input.responsesJson;
  if (!responsesJson) {
    const consent = one(
      await db.select().from(consentVersions).where(eq(consentVersions.id, input.consentVersionId)),
    );
    responsesJson = consent.itemsJson.map((item) => ({
      itemId: item.id,
      textSnapshot: item.text,
      required: item.required,
      accepted: true,
    }));
  }
  return one(
    await db
      .insert(sessionConsents)
      .values({ ...input, responsesJson })
      .returning(),
  );
}

// Inserts the record of a task shown to the participant, with snapshots copied from the task.
export async function insertTaskPresentation(
  db: DbOrTx,
  input: { sessionId: string; protocolTaskId: string } & Partial<typeof taskPresentations.$inferInsert>,
): Promise<TaskPresentationRow> {
  const task = one(await db.select().from(protocolTasks).where(eq(protocolTasks.id, input.protocolTaskId)));
  let sequenceIndex = input.sequenceIndex;
  if (sequenceIndex === undefined) {
    const existing = await db
      .select({ sequenceIndex: taskPresentations.sequenceIndex })
      .from(taskPresentations)
      .where(eq(taskPresentations.sessionId, input.sessionId));
    sequenceIndex = existing.reduce((max, row) => Math.max(max, row.sequenceIndex), -1) + 1;
  }
  return one(
    await db
      .insert(taskPresentations)
      .values({
        titleSnapshot: task.title,
        promptSnapshot: task.participantPrompt,
        contextSnapshot: task.contextText,
        instructionsSnapshot: task.instructionsText,
        ...input,
        sequenceIndex,
      })
      .returning(),
  );
}

// Inserts a media metadata row only. No file is written to storage.
export async function insertMediaAsset(
  db: DbOrTx,
  input: { studyId: string } & Partial<typeof mediaAssets.$inferInsert>,
): Promise<MediaAssetRow> {
  const id = input.id ?? randomUUID();
  return one(
    await db
      .insert(mediaAssets)
      .values({
        id,
        entityType: input.utteranceId ? "utterance" : "study",
        entityId: input.utteranceId ?? null,
        kind: "source_audio",
        storageDriver: "local",
        storageKey: `test/${id}.wav`,
        mimeType: "audio/wav",
        container: "wav",
        codec: "pcm_s16le",
        sampleRateHz: 48000,
        channels: 1,
        bitDepth: 16,
        durationMs: 4000,
        sizeBytes: 384044,
        sha256: randomSha256(),
        captureMethod: "audio_worklet_pcm",
        captureQualityClass: "lossless_pcm",
        ...input,
      })
      .returning(),
  );
}

// Inserts an utterance together with its accepted source audio metadata row.
// The result is a submitted utterance unless another status is given. The
// media row describes a file that does not exist in storage.
export async function insertUtteranceWithMedia(
  db: DbOrTx,
  input: {
    sessionId: string;
    taskPresentationId: string;
    utterance?: Partial<typeof utterances.$inferInsert>;
    media?: Partial<typeof mediaAssets.$inferInsert>;
  },
): Promise<{ utterance: UtteranceRow; media: MediaAssetRow }> {
  const session = one(await db.select().from(sessions).where(eq(sessions.id, input.sessionId)));
  const presentation = one(
    await db.select().from(taskPresentations).where(eq(taskPresentations.id, input.taskPresentationId)),
  );
  let turnIndex = input.utterance?.turnIndex;
  if (turnIndex === undefined) {
    const existing = await db
      .select({ turnIndex: utterances.turnIndex })
      .from(utterances)
      .where(eq(utterances.taskPresentationId, input.taskPresentationId));
    turnIndex = existing.reduce((max, row) => Math.max(max, row.turnIndex), -1) + 1;
  }
  const finalStatus = input.utterance?.status ?? "submitted";
  const created = one(
    await db
      .insert(utterances)
      .values({
        promptSnapshot: presentation.promptSnapshot,
        ...input.utterance,
        sessionId: input.sessionId,
        taskPresentationId: input.taskPresentationId,
        turnIndex,
        status: "uploading",
        submittedAt: null,
        acceptedMediaAssetId: null,
      })
      .returning(),
  );
  const media = await insertMediaAsset(db, {
    studyId: session.studyId,
    sessionId: session.id,
    utteranceId: created.id,
    ...input.media,
  });
  const utterance = one(
    await db
      .update(utterances)
      .set({
        acceptedMediaAssetId: media.id,
        durationMs: input.utterance?.durationMs ?? media.durationMs,
        submittedAt: input.utterance?.submittedAt ?? new Date(),
        status: finalStatus,
      })
      .where(eq(utterances.id, created.id))
      .returning(),
  );
  return { utterance, media };
}

// Inserts a transcript (or reuses the one for this utterance and type) and adds
// a revision as the current one. An earlier current revision is switched off first.
export async function insertTranscriptWithRevision(
  db: DbOrTx,
  input: {
    utteranceId: string;
    type?: (typeof transcripts.$inferInsert)["type"];
    status?: (typeof transcripts.$inferInsert)["status"];
    text?: string;
    revision?: Partial<Omit<typeof transcriptRevisions.$inferInsert, "transcriptId">>;
  },
): Promise<{ transcript: TranscriptRow; revision: TranscriptRevisionRow }> {
  const type = input.type ?? "human_dialect";
  const existing = (await db.select().from(transcripts).where(eq(transcripts.utteranceId, input.utteranceId))).find(
    (row) => row.type === type,
  );
  const transcript =
    existing ??
    one(
      await db
        .insert(transcripts)
        .values({ utteranceId: input.utteranceId, type, status: input.status ?? "draft" })
        .returning(),
    );
  const earlier = await db
    .select({ revisionNumber: transcriptRevisions.revisionNumber })
    .from(transcriptRevisions)
    .where(eq(transcriptRevisions.transcriptId, transcript.id));
  await db
    .update(transcriptRevisions)
    .set({ isCurrent: false })
    .where(eq(transcriptRevisions.transcriptId, transcript.id));
  const revision = one(
    await db
      .insert(transcriptRevisions)
      .values({
        revisionNumber: earlier.reduce((max, row) => Math.max(max, row.revisionNumber), 0) + 1,
        text: input.text ?? "Mie en oikeestaan tiiä.",
        createdByType: type === "asr" ? "model" : "researcher",
        createdByLabel: type === "asr" ? null : "test-researcher",
        isCurrent: true,
        ...input.revision,
        transcriptId: transcript.id,
      })
      .returning(),
  );
  return { transcript, revision };
}

export type ActiveAiConfigs = {
  prompts: {
    asrContext: AiPromptVersionRow;
    translationDefault: AiPromptVersionRow;
    translationPreserve: AiPromptVersionRow;
    ttsBaseline: AiPromptVersionRow;
  };
  configs: {
    asrDefault: ModelConfigRow;
    translationDefault: ModelConfigRow;
    translationPreserve: ModelConfigRow;
    ttsBaseline: ModelConfigRow;
  };
};

// Inserts one active prompt and one active model config for each of the four
// seeded keys, with mock provider and model names (override with provider, models).
export async function insertActiveAiConfigs(
  db: DbOrTx,
  input: {
    studyId: string;
    provider?: string;
    models?: { asr?: string; translation?: string; tts?: string };
  },
): Promise<ActiveAiConfigs> {
  const provider = input.provider ?? "mock";
  const models = { asr: "mock-asr", translation: "mock-translation", tts: "mock-tts", ...input.models };
  const now = new Date();
  const prompt = async (values: Omit<typeof aiPromptVersions.$inferInsert, "studyId" | "versionNumber">) =>
    one(
      await db
        .insert(aiPromptVersions)
        .values({ versionNumber: 1, status: "active", activatedAt: now, ...values, studyId: input.studyId })
        .returning(),
    );
  const config = async (values: Omit<typeof modelConfigs.$inferInsert, "studyId" | "versionNumber" | "provider">) =>
    one(
      await db
        .insert(modelConfigs)
        .values({
          versionNumber: 1,
          status: "active",
          activatedAt: now,
          provider,
          ...values,
          studyId: input.studyId,
        })
        .returning(),
    );

  const prompts = {
    asrContext: await prompt({
      key: "asr_context",
      stage: "asr",
      name: "ASR context (test)",
      promptText: "Spoken Finnish.",
    }),
    translationDefault: await prompt({
      key: "translation_default",
      stage: "translation",
      conditionKey: "default",
      name: "Default translation (test)",
      promptText: "Translate the Finnish utterance into English. Return only the translation.",
    }),
    translationPreserve: await prompt({
      key: "translation_preserve",
      stage: "translation",
      conditionKey: "preservation",
      name: "Preservation translation (test)",
      promptText: "Translate the Finnish utterance into English and keep its register. Return only the translation.",
    }),
    ttsBaseline: await prompt({
      key: "tts_baseline",
      stage: "tts",
      conditionKey: "baseline",
      name: "TTS baseline (test)",
      promptText: "Speak the text naturally.",
    }),
  };
  const configs = {
    asrDefault: await config({
      key: "asr_default",
      stage: "asr",
      modelId: models.asr,
      parametersJson: { language: "fi" },
      promptVersionId: prompts.asrContext.id,
    }),
    translationDefault: await config({
      key: "translation_default",
      stage: "translation",
      conditionKey: "default",
      modelId: models.translation,
      promptVersionId: prompts.translationDefault.id,
    }),
    translationPreserve: await config({
      key: "translation_preserve",
      stage: "translation",
      conditionKey: "preservation",
      modelId: models.translation,
      promptVersionId: prompts.translationPreserve.id,
    }),
    ttsBaseline: await config({
      key: "tts_baseline",
      stage: "tts",
      conditionKey: "baseline",
      modelId: models.tts,
      parametersJson: { voice: "mock-voice", response_format: "wav" },
      promptVersionId: prompts.ttsBaseline.id,
    }),
  };
  return { prompts, configs };
}

// A minimal valid configuration snapshot for a batch.
export function emptyBatchSnapshot(
  overrides: Partial<BatchConfigurationSnapshot> = {},
): BatchConfigurationSnapshot {
  return {
    selection: {
      mode: ["research"],
      completedSessionsOnly: true,
      verifiedTranscriptsOnly: true,
      excludeFlagged: false,
      excludeExcluded: true,
    },
    transcriptTypes: ["human_dialect"],
    runAsr: false,
    asr: null,
    translations: [],
    tts: [],
    sourceLanguage: "fi",
    targetLanguage: "en",
    utteranceIds: [],
    ...overrides,
  };
}

// Inserts a processing batch. Default status "draft", default data mode "research".
export async function insertProcessingBatch(
  db: DbOrTx,
  input: { studyId: string } & Partial<typeof processingBatches.$inferInsert>,
): Promise<ProcessingBatchRow> {
  return one(
    await db
      .insert(processingBatches)
      .values({
        name: `batch-${shortId()}`,
        configurationSnapshotJson: emptyBatchSnapshot(),
        ...input,
      })
      .returning(),
  );
}

// Inserts a model run. Default status "running" (the column default).
export async function insertModelRun(
  db: DbOrTx,
  input: { sourceEntityType: string; sourceEntityId: string } & Partial<typeof modelRuns.$inferInsert>,
): Promise<ModelRunRow> {
  return one(
    await db
      .insert(modelRuns)
      .values({
        stage: "translation",
        provider: "mock",
        requestedModel: "mock-translation",
        inputManifestJson: {},
        appVersion: "test",
        idempotencyKey: `test-run-${randomUUID()}`,
        ...input,
      })
      .returning(),
  );
}

// Inserts a succeeded translation model run and its translation row.
export async function insertTranslation(
  db: DbOrTx,
  input: {
    sourceTranscriptRevisionId: string;
    processingBatchId: string;
    conditionKey?: string;
    translatedText?: string;
    modelRun?: Partial<typeof modelRuns.$inferInsert>;
  } & Partial<typeof translations.$inferInsert>,
): Promise<{ translation: TranslationRow; modelRun: ModelRunRow }> {
  const { modelRun: modelRunOverrides, ...translationValues } = input;
  const conditionKey = input.conditionKey ?? "default";
  const modelRun = await insertModelRun(db, {
    stage: "translation",
    sourceEntityType: "transcript_revision",
    sourceEntityId: input.sourceTranscriptRevisionId,
    processingBatchId: input.processingBatchId,
    conditionKey,
    status: "succeeded",
    finishedAt: new Date(),
    latencyMs: 10,
    ...modelRunOverrides,
  });
  const translation = one(
    await db
      .insert(translations)
      .values({
        translatedText: "I don't really know.",
        modelRunId: modelRun.id,
        ...translationValues,
        conditionKey,
      })
      .returning(),
  );
  return { translation, modelRun };
}

// Inserts a succeeded TTS model run, a tts_audio media metadata row (no file)
// and the synthesis row for a translation.
export async function insertSynthesis(
  db: DbOrTx,
  input: {
    studyId: string;
    translationId: string;
    processingBatchId: string;
    conditionKey?: string;
    sourceText?: string;
    modelRun?: Partial<typeof modelRuns.$inferInsert>;
    media?: Partial<typeof mediaAssets.$inferInsert>;
  } & Partial<typeof syntheses.$inferInsert>,
): Promise<{ synthesis: SynthesisRow; modelRun: ModelRunRow; media: MediaAssetRow }> {
  const { studyId, modelRun: modelRunOverrides, media: mediaOverrides, ...synthesisValues } = input;
  const conditionKey = input.conditionKey ?? "default";
  const modelRun = await insertModelRun(db, {
    stage: "tts",
    requestedModel: "mock-tts",
    sourceEntityType: "translation",
    sourceEntityId: input.translationId,
    processingBatchId: input.processingBatchId,
    conditionKey,
    status: "succeeded",
    finishedAt: new Date(),
    latencyMs: 10,
    ...modelRunOverrides,
  });
  const synthesisId = input.id ?? randomUUID();
  const media = await insertMediaAsset(db, {
    studyId,
    kind: "tts_audio",
    entityType: "synthesis",
    entityId: synthesisId,
    captureMethod: null,
    captureQualityClass: null,
    ...mediaOverrides,
  });
  const synthesis = one(
    await db
      .insert(syntheses)
      .values({
        sourceText: "I don't really know.",
        voiceKey: "mock-voice",
        modelRunId: modelRun.id,
        mediaAssetId: media.id,
        ...synthesisValues,
        id: synthesisId,
        conditionKey,
      })
      .returning(),
  );
  return { synthesis, modelRun, media };
}

export type CollectedSession = {
  study: StudyRow;
  consent: ConsentVersionRow;
  protocol: ProtocolVersionRow;
  tasks: ProtocolTaskRow[];
  followups: ProtocolTaskFollowupRow[];
  session: SessionRow;
  sessionConsent: SessionConsentRow;
  presentation: TaskPresentationRow;
  utterance: UtteranceRow;
  media: MediaAssetRow;
};

// One call that builds a study (or uses studyId and protocolVersionId when given),
// a published protocol, a consented session, the first task presentation and one
// submitted utterance with its media metadata row.
export async function insertSessionWithUtterance(
  db: DbOrTx,
  input: {
    studyId?: string;
    protocolVersionId?: string;
    session?: Partial<typeof sessions.$inferInsert>;
    utterance?: Partial<typeof utterances.$inferInsert>;
    media?: Partial<typeof mediaAssets.$inferInsert>;
  } = {},
): Promise<CollectedSession> {
  const study = input.studyId
    ? one(await db.select().from(studies).where(eq(studies.id, input.studyId)))
    : await insertStudy(db);
  let protocol: ProtocolVersionRow;
  let tasks: ProtocolTaskRow[];
  let followups: ProtocolTaskFollowupRow[];
  if (input.protocolVersionId) {
    protocol = one(
      await db.select().from(protocolVersions).where(eq(protocolVersions.id, input.protocolVersionId)),
    );
    tasks = await db
      .select()
      .from(protocolTasks)
      .where(eq(protocolTasks.protocolVersionId, protocol.id))
      .orderBy(protocolTasks.orderIndex);
    followups = [];
    for (const task of tasks) {
      followups.push(
        ...(await db.select().from(protocolTaskFollowups).where(eq(protocolTaskFollowups.protocolTaskId, task.id))),
      );
    }
  } else {
    ({ protocol, tasks, followups } = await insertPublishedProtocol(db, { studyId: study.id }));
  }
  if (!protocol.consentVersionId) throw new Error("The protocol version has no consent version");
  const consent = one(
    await db.select().from(consentVersions).where(eq(consentVersions.id, protocol.consentVersionId)),
  );
  const firstTask = tasks[0];
  if (!firstTask) throw new Error("The protocol version has no tasks");
  const session = await insertSession(db, {
    studyId: study.id,
    protocolVersionId: protocol.id,
    status: "recording",
    consentedAt: new Date(),
    ...input.session,
  });
  const sessionConsent = await insertSessionConsent(db, {
    sessionId: session.id,
    consentVersionId: consent.id,
  });
  const presentation = await insertTaskPresentation(db, {
    sessionId: session.id,
    protocolTaskId: firstTask.id,
    status: "started",
    startedAt: new Date(),
  });
  const { utterance, media } = await insertUtteranceWithMedia(db, {
    sessionId: session.id,
    taskPresentationId: presentation.id,
    utterance: input.utterance,
    media: input.media,
  });
  return { study, consent, protocol, tasks, followups, session, sessionConsent, presentation, utterance, media };
}
