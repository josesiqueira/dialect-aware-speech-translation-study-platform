// Full cross-slice integration test (spec 90.2).
//
// One scenario through the real services, a real PostgreSQL database, in-memory
// storage holding real WAV bytes, and the mock AI provider:
// study setup, participant session, automatic ASR, human review of B and C,
// processing batch, lineage, dataset package, corpus read models.
// A TEST-mode session runs next to it and must stay out of the research export.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { modelRuns, syntheses, translations } from "@dialect/db";
import { sha256OfBuffer } from "@dialect/storage";
import * as corpus from "../corpus";
import { csvObjects } from "../exports/test-helpers";
import { RESEARCH_TEST_PROVIDER } from "../processing/test-helpers";
import type { ExportManifest } from "../exports";
import * as processing from "../processing";
import * as protocols from "../protocols";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import * as transcripts from "../transcripts";
import {
  BACKGROUND_ANSWERS,
  POST_ANSWERS,
  buildExportArchive,
  drainQueue,
  jobsOf,
  mediaRow,
  reviewUtterance,
  runSession,
  setupStudy,
  storedBytes,
  utteranceRow,
  type ReviewedUtterance,
  type ScenarioStudy,
  type SessionRun,
} from "./scenario";

// Each test drives a part of one whole scenario (sessions, queue, three model
// stages, export) against a database. The default of 5 seconds per test is too
// short when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestServiceContext;
let study: ScenarioStudy;
let research: SessionRun;
let testRun: SessionRun;
const reviewed = new Map<string, ReviewedUtterance>();
let batch: processing.BatchDetail;
let testBatch: processing.BatchDetail;
let files: Map<string, Buffer>;

const text = (name: string) => {
  const file = files.get(name);
  if (!file) throw new Error(`The archive has no file ${name}`);
  return file.toString("utf8");
};
const rows = (name: string) => csvObjects(text(name));

beforeAll(async () => {
  t = await createTestServiceContext();
});
afterAll(async () => {
  await t.cleanup();
});

describe("full pipeline: from study setup to the dataset package", () => {
  it("1. sets up a study with consent, questionnaires and a protocol through the services", async () => {
    study = await setupStudy(t);
    const { protocol, tasks, consentVersion, backgroundQuestionnaire, postQuestionnaire } = study.protocol;
    expect(protocol).toMatchObject({ status: "published", versionNumber: 1, isCurrent: true });
    expect(tasks.map((task) => [task.taskKey, task.taskType])).toEqual([
      ["invite_friend", "controlled"],
      ["last_weekend", "semi_structured"],
      ["free_topic", "free_speech"],
    ]);
    // The edit made before publication is what was published.
    expect(tasks[1]!.participantPrompt).toBe("Tell what you did last weekend, in your own words.");
    expect(tasks[1]!.followups.map((followup) => followup.promptText)).toEqual(["What was the best part of it?"]);
    expect(consentVersion?.publishedAt).not.toBeNull();
    expect(backgroundQuestionnaire).toMatchObject({ key: "background", status: "published" });
    expect(postQuestionnaire).toMatchObject({ key: "post_recording", status: "published" });
    expect((await protocols.getCurrentProtocol(t.adminCtx, study.study.id))?.protocol.id).toBe(protocol.id);
  });

  it("2. and 3. a participant consents, records every turn, answers both questionnaires and completes", async () => {
    research = await runSession(t.ctx, study.slug);
    expect(research.finalState.step).toBe("completed");
    expect(research.session.mode).toBe("research");
    expect(research.session.protocolVersionId).toBe(study.protocol.protocol.id);

    // Four turns: controlled, semi-structured, its follow-up, free speech.
    expect(research.turns.map((turn) => [turn.taskType, turn.isFollowup, turn.promptText])).toEqual([
      ["controlled", false, "Ask a friend to come for coffee on Saturday."],
      ["semi_structured", false, "Tell what you did last weekend, in your own words."],
      ["semi_structured", true, "What was the best part of it?"],
      ["free_speech", false, "Talk about anything you like."],
    ]);
    for (const turn of research.turns) {
      const utterance = await utteranceRow(t.ctx, turn.utteranceId);
      expect(utterance).toMatchObject({
        status: "submitted",
        acceptedMediaAssetId: turn.mediaAssetId,
        promptSnapshot: turn.promptText,
      });
      const media = await mediaRow(t.ctx, turn.mediaAssetId);
      expect(media).toMatchObject({ kind: "source_audio", sha256: turn.sha256, captureQualityClass: "lossless_pcm" });
      // The stored bytes are the uploaded bytes.
      expect((await storedBytes(t.ctx, media.storageKey)).equals(turn.audio)).toBe(true);
    }
  });

  it("4. the automatic ASR jobs run from the queue with the real handlers", async () => {
    const queued = await jobsOf(t.ctx, { type: "asr" });
    expect(queued.map((job) => job.status)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(await drainQueue(t.ctx)).toBe(4);
    expect((await jobsOf(t.ctx, { type: "asr" })).map((job) => job.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    for (const turn of research.turns) {
      const lineage = await processing.getUtteranceLineage(t.adminCtx, turn.utteranceId);
      const asr = lineage.transcripts.find((transcript) => transcript.type === "asr");
      expect(asr?.revisions).toHaveLength(1);
      expect(asr!.revisions[0]).toMatchObject({ createdByType: "model", isCurrent: true });
      expect(asr!.revisions[0]!.text).toContain("[mock-transkriptio");
      expect(asr!.revisions[0]!.provenance?.modelRun).toMatchObject({
        stage: "asr",
        status: "succeeded",
        provider: RESEARCH_TEST_PROVIDER,
        processingBatchId: null,
      });
      expect(asr!.revisions[0]!.provenance?.modelRun.inputManifest).toMatchObject({ mediaSha256: turn.sha256 });
    }
  });

  it("5. the researcher saves and verifies B and C, corrects A for one utterance, and codes an A vs B difference", async () => {
    t.clock.advance(60_000);
    for (const [index, turn] of research.turns.entries()) {
      reviewed.set(
        turn.utteranceId,
        await reviewUtterance(t.adminCtx, turn.utteranceId, {
          b: `Mie en oikeestaan tiiä, lausuma ${index + 1}.`,
          c: `Minä en oikeastaan tiedä, lausuma ${index + 1}.`,
          ...(index === 0 ? { aStar: "Mie en oikeestaan tiiä (korjattu ASR)." } : {}),
        }),
      );
    }
    const first = research.turns[0]!;
    const review = await transcripts.getUtteranceForReview(t.adminCtx, first.utteranceId);
    expect(review.transcripts.human_dialect).toMatchObject({ status: "verified" });
    expect(review.transcripts.normalized).toMatchObject({ status: "verified" });
    expect(review.transcripts.asr_corrected).toMatchObject({ status: "verified" });
    const asrRevisionId = review.transcripts.asr!.currentRevision!.id;

    const coded = await transcripts.saveDifferenceAnnotation(t.adminCtx, {
      utteranceId: first.utteranceId,
      sourceTranscriptRevisionId: asrRevisionId,
      targetTranscriptRevisionId: reviewed.get(first.utteranceId)!.b.revisionId,
      categories: ["recognition_error", "normalization"],
      notes: "ASR wrote the standard form.",
    });
    expect(coded.annotation).toMatchObject({
      sourceTranscriptType: "asr",
      targetTranscriptType: "human_dialect",
      categories: ["recognition_error", "normalization"],
    });
  });

  it("6. a processing batch with A, B and C, both translation conditions and the TTS baseline runs to completion", async () => {
    t.clock.advance(60_000);
    const created = await processing.createBatch(t.adminCtx, {
      studyId: study.study.id,
      name: "integration pilot",
      transcriptTypes: ["asr", "human_dialect", "normalized"],
      translationModelConfigIds: [study.ai.configs.translationDefault.id, study.ai.configs.translationPreserve.id],
      ttsModelConfigIds: [study.ai.configs.ttsBaseline.id],
    });
    expect(created).toMatchObject({ status: "draft", dataMode: "research", utteranceCount: 4 });
    const started = await processing.startBatch(t.adminCtx, created.id);
    expect(started.status).toBe("queued");
    // 4 utterances x 3 transcript types x 2 conditions, then one synthesis each.
    expect(await drainQueue(t.ctx)).toBe(48);
    batch = await processing.getBatch(t.adminCtx, created.id);
    expect(batch).toMatchObject({
      status: "completed",
      outputCounts: { translations: 24, syntheses: 24 },
      modelRunCounts: { succeeded: 48, failed: 0, running: 0 },
    });
    expect(batch.jobCounts).toMatchObject({ succeeded: 48, failed: 0, queued: 0, total: 48 });
  });

  it("the same pipeline for a TEST-mode session runs in its own test batch", async () => {
    testRun = await runSession(t.ctx, study.slug, { mode: "test" });
    expect(testRun.finalState.step).toBe("completed");
    expect(await drainQueue(t.ctx)).toBe(4);
    // A research batch cannot take the test session in.
    await expect(
      processing.createBatch(t.adminCtx, {
        studyId: study.study.id,
        name: "mixed",
        selection: { sessionIds: [testRun.session.id] },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const created = await processing.createBatch(t.adminCtx, {
      studyId: study.study.id,
      name: "integration test-mode batch",
      selection: { mode: "test" },
      transcriptTypes: ["asr"],
    });
    expect(created).toMatchObject({ dataMode: "test", utteranceCount: 4 });
    await processing.startBatch(t.adminCtx, created.id);
    expect(await drainQueue(t.ctx)).toBe(16);
    testBatch = await processing.getBatch(t.adminCtx, created.id);
    expect(testBatch).toMatchObject({ status: "completed", outputCounts: { translations: 8, syntheses: 8 } });
  });

  it("7. the full matrix exists, and the lineage of one synthesis answers every question of spec 158", async () => {
    for (const turn of research.turns) {
      const lineage = await processing.getUtteranceLineage(t.adminCtx, turn.utteranceId);
      expect(lineage.batches.map((entry) => entry.batch.id)).toEqual([batch.id]);
      const cells = lineage.batches[0]!.translations.map(
        (translation) => `${translation.source.transcriptLabel}:${translation.conditionKey}`,
      );
      expect(cells.sort()).toEqual(["A:default", "A:preservation", "B:default", "B:preservation", "C:default", "C:preservation"]);
      for (const translation of lineage.batches[0]!.translations) {
        expect(translation.syntheses.map((synthesis) => synthesis.conditionKey)).toEqual(["baseline"]);
      }
      expect(lineage.failedRuns).toEqual([]);
    }

    const turn = research.turns[1]!;
    const review = reviewed.get(turn.utteranceId)!;
    const lineage = await processing.getUtteranceLineage(t.adminCtx, turn.utteranceId);
    const translation = lineage.batches[0]!.translations.find(
      (candidate) => candidate.source.transcriptType === "human_dialect" && candidate.conditionKey === "preservation",
    )!;
    const synthesis = translation.syntheses[0]!;

    // Which participant and session?
    expect(lineage.session).toMatchObject({
      id: research.session.id,
      participantCode: research.participantCode,
      mode: "research",
      status: "completed",
    });
    // Which source utterance?
    expect(lineage.utterance).toMatchObject({ id: turn.utteranceId, status: "submitted" });
    // Which exact source audio file and hash?
    expect(lineage.sourceAsset).toMatchObject({ id: turn.mediaAssetId, sha256: turn.sha256, kind: "source_audio" });
    expect(lineage.sourceAsset!.storageKey).not.toBe("");
    expect(sha256OfBuffer(await storedBytes(t.ctx, lineage.sourceAsset!.storageKey))).toBe(turn.sha256);
    // Which task and exact prompt?
    expect(lineage.task).toMatchObject({
      taskPresentationId: turn.presentationId,
      taskKey: "last_weekend",
      taskType: "semi_structured",
      titleSnapshot: "Last weekend",
      promptSnapshot: "Tell what you did last weekend, in your own words.",
    });
    expect(lineage.utterance.promptSnapshot).toBe("Tell what you did last weekend, in your own words.");
    // Which transcript condition? Which transcript revision?
    expect(translation.source).toMatchObject({
      transcriptType: "human_dialect",
      transcriptLabel: "B",
      transcriptRevisionId: review.b.revisionId,
      revisionNumber: 1,
    });
    const sourceRevision = lineage.transcripts
      .find((transcript) => transcript.type === "human_dialect")!
      .revisions.find((revision) => revision.id === review.b.revisionId)!;
    expect(sourceRevision.text).toBe(review.b.text);
    expect(sourceRevision.verifiedAt).not.toBeNull();
    // Which translation condition?
    expect(translation.conditionKey).toBe("preservation");
    // Which translation prompt version?
    expect(translation.provenance.promptVersion).toMatchObject({
      id: study.ai.prompts.translationPreserve.id,
      key: "translation_preserve",
      versionNumber: 1,
      promptText: study.ai.prompts.translationPreserve.promptText,
    });
    // Which model and configuration?
    expect(translation.provenance.modelConfig).toMatchObject({
      id: study.ai.configs.translationPreserve.id,
      key: "translation_preserve",
      versionNumber: 1,
      provider: RESEARCH_TEST_PROVIDER,
      modelId: "mock-translation",
    });
    expect(translation.provenance.modelRun).toMatchObject({
      stage: "translation",
      status: "succeeded",
      provider: RESEARCH_TEST_PROVIDER,
      requestedModel: "mock-translation",
      returnedModel: "mock",
      attemptNumber: 1,
    });
    // Which processing batch?
    expect(lineage.batches[0]!.batch).toMatchObject({ id: batch.id, name: "integration pilot", dataMode: "research" });
    expect(translation.provenance.modelRun.processingBatchId).toBe(batch.id);
    expect(synthesis.batch.id).toBe(batch.id);
    // Which exact translated text?
    expect(translation.translatedText).toContain(review.b.text);
    expect(translation.translatedText).toMatch(/^\[mock translation /);
    expect(synthesis.sourceText).toBe(translation.translatedText);
    // Which TTS model, configuration and voice?
    expect(synthesis.voiceKey).toBe("mock-voice");
    expect(synthesis.provenance.modelConfig).toMatchObject({
      id: study.ai.configs.ttsBaseline.id,
      key: "tts_baseline",
      provider: RESEARCH_TEST_PROVIDER,
      modelId: "mock-tts",
    });
    expect(synthesis.provenance.modelRun).toMatchObject({ stage: "tts", status: "succeeded", requestedModel: "mock-tts" });
    expect(synthesis.provenance.promptVersion).toMatchObject({ id: study.ai.prompts.ttsBaseline.id });
    expect(synthesis.asset.kind).toBe("tts_audio");
    expect(sha256OfBuffer(await storedBytes(t.ctx, synthesis.asset.storageKey))).toBe(synthesis.asset.sha256);
    // When was it generated?
    expect(synthesis.createdAt).toEqual(t.clock.now());
    expect(synthesis.provenance.modelRun.startedAt).toBeInstanceOf(Date);
    expect(synthesis.provenance.modelRun.finishedAt).toBeInstanceOf(Date);
    expect(translation.provenance.modelRun.finishedAt).toBeInstanceOf(Date);
    // Which app version produced the run?
    expect(synthesis.provenance.modelRun.appVersion).toBe("test");
    expect(translation.provenance.modelRun.appVersion).toBe("test");
    expect(lineage.session.appVersion).toBe("test");
  });

  it("8. the dataset package holds the same relationships, and every manifest hash matches", async () => {
    t.clock.advance(60_000);
    const built = await buildExportArchive(t.adminCtx, {
      exportType: "dataset_package",
      options: { includeSourceAudio: true, includeGeneratedAudio: true },
    });
    files = built.files;
    const manifest = JSON.parse(text("MANIFEST.json")) as ExportManifest;

    // Every file of the archive is listed, and every listed hash matches.
    expect(manifest.files.map((file) => file.path).sort()).toEqual(
      [...files.keys()].filter((name) => name !== "MANIFEST.json").sort(),
    );
    for (const file of manifest.files) {
      const content = files.get(file.path)!;
      expect(content.length, file.path).toBe(file.size_bytes);
      expect(sha256OfBuffer(content), file.path).toBe(file.sha256);
    }
    expect(manifest).toMatchObject({
      export_type: "dataset_package",
      privacy_tier: "internal_full",
      counts: { sessions: 1, utterances: 4, source_audio_files: 4, generated_audio_files: 24 },
    });
    expect(manifest.processing_batches.map((entry) => entry.id)).toEqual([batch.id]);

    // One synthesis traced back to its source audio file by ids, from the files alone.
    const turn = research.turns[1]!;
    const review = reviewed.get(turn.utteranceId)!;
    const translation = rows("translations.csv").find(
      (row) => row.source_transcript_revision_id === review.b.revisionId && row.condition_key === "preservation",
    )!;
    const synthesis = rows("syntheses.csv").find((row) => row.translation_id === translation.translation_id)!;
    const revision = rows("transcripts.csv").find(
      (row) => row.transcript_revision_id === translation.source_transcript_revision_id,
    )!;
    const utterance = rows("utterances.csv").find((row) => row.utterance_id === revision.utterance_id)!;
    const presentation = rows("task_presentations.csv").find(
      (row) => row.task_presentation_id === utterance.task_presentation_id,
    )!;
    const session = rows("sessions.csv").find((row) => row.session_id === utterance.session_id)!;
    const media = rows("media_assets.csv");
    const sourceMedia = media.find((row) => row.media_asset_id === utterance.source_media_asset_id)!;
    const ttsMedia = media.find((row) => row.media_asset_id === synthesis.media_asset_id)!;
    const runs = text("model_runs.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const translationRun = runs.find((run) => run.model_run_id === translation.model_run_id)!;
    const ttsRun = runs.find((run) => run.model_run_id === synthesis.model_run_id)!;
    const exportedBatches = JSON.parse(text("processing_batches.json")) as Array<Record<string, unknown>>;
    const exportedBatch = exportedBatches.find((entry) => entry.processing_batch_id === synthesis.processing_batch_id)!;
    const prompt = JSON.parse(text(`prompts/${translation.prompt_key}-v${translation.prompt_version_number}.json`)) as Record<string, unknown>;
    const ttsConfig = JSON.parse(
      text(`model_configs/${synthesis.model_config_key}-v${synthesis.model_config_version}.json`),
    ) as Record<string, unknown>;

    expect(session).toMatchObject({ session_id: research.session.id, participant_code: research.participantCode });
    expect(utterance.utterance_id).toBe(turn.utteranceId);
    expect(utterance.source_media_asset_id).toBe(turn.mediaAssetId);
    expect(utterance.source_sha256).toBe(turn.sha256);
    expect(sourceMedia.sha256).toBe(turn.sha256);
    // The source audio file inside the archive is the recording the participant uploaded.
    expect(files.get(utterance.source_audio_file!)!.equals(turn.audio)).toBe(true);
    expect(presentation.prompt_snapshot).toBe("Tell what you did last weekend, in your own words.");
    expect(revision).toMatchObject({ transcript_type: "human_dialect", transcript_label: "B", verified: "true" });
    expect(revision.text).toBe(review.b.text);
    expect(translationRun).toMatchObject({ stage: "translation", processing_batch_id: batch.id, app_version: "test" });
    expect(prompt.id).toBe(study.ai.prompts.translationPreserve.id);
    expect(exportedBatch.name).toBe("integration pilot");
    expect(synthesis.source_text).toBe(translation.translated_text);
    expect(synthesis.voice_key).toBe("mock-voice");
    expect(ttsConfig.id).toBe(study.ai.configs.ttsBaseline.id);
    expect(ttsRun).toMatchObject({ stage: "tts", app_version: "test" });
    expect(ttsMedia.sha256).toBe(synthesis.media_sha256);
    expect(sha256OfBuffer(files.get(synthesis.audio_file!)!)).toBe(synthesis.media_sha256);
    expect(manifest.files.find((file) => file.path === synthesis.audio_file)).toMatchObject({
      media_asset_id: synthesis.media_asset_id,
      database_sha256: synthesis.media_sha256,
    });
    // Every exported row links to a row that is in the package.
    const utteranceIds = new Set(rows("utterances.csv").map((row) => row.utterance_id));
    const revisionIds = new Set(rows("transcripts.csv").map((row) => row.transcript_revision_id));
    const translationIds = new Set(rows("translations.csv").map((row) => row.translation_id));
    const runIds = new Set(runs.map((run) => run.model_run_id));
    expect(utteranceIds).toEqual(new Set(research.turns.map((entry) => entry.utteranceId)));
    for (const row of rows("transcripts.csv")) expect(utteranceIds.has(row.utterance_id!)).toBe(true);
    for (const row of rows("translations.csv")) {
      expect(revisionIds.has(row.source_transcript_revision_id!)).toBe(true);
      expect(runIds.has(row.model_run_id)).toBe(true);
    }
    for (const row of rows("syntheses.csv")) {
      expect(translationIds.has(row.translation_id!)).toBe(true);
      expect(runIds.has(row.model_run_id)).toBe(true);
      expect(files.has(row.audio_file!)).toBe(true);
    }
    expect(rows("translations.csv")).toHaveLength(24);
    expect(rows("syntheses.csv")).toHaveLength(24);
    // The questionnaire answers and the A vs B coding are part of the package.
    const answers = Object.fromEntries(rows("questionnaire_responses.csv").map((row) => [row.item_key, row.value ?? row.answer]));
    expect(Object.keys(answers).sort()).toEqual(["age_range", "comment", "naturalness", "region_grew_up"]);
    expect(rows("annotations.csv").some((row) => row.utterance_id === research.turns[0]!.utteranceId)).toBe(true);
  });

  it("the default research export contains nothing of the TEST-mode session or its batch", async () => {
    const forbidden = [
      testRun.session.id,
      testRun.participantCode,
      testBatch.id,
      testBatch.name,
      ...testRun.turns.flatMap((turn) => [turn.utteranceId, turn.mediaAssetId, turn.sha256]),
    ];
    const testOutputs = await t.ctx.db.select().from(translations).where(eq(translations.processingBatchId, testBatch.id));
    const testSyntheses = await t.ctx.db.select().from(syntheses).where(eq(syntheses.processingBatchId, testBatch.id));
    const testRuns = await t.ctx.db.select().from(modelRuns).where(eq(modelRuns.processingBatchId, testBatch.id));
    expect(testOutputs).toHaveLength(8);
    expect(testSyntheses).toHaveLength(8);
    forbidden.push(...testOutputs.map((row) => row.id), ...testSyntheses.map((row) => row.id), ...testRuns.map((row) => row.id));

    for (const [name, content] of files) {
      if (name.startsWith("source_audio/") || name.startsWith("generated_audio/")) {
        expect(name).not.toContain(testRun.participantCode);
        for (const turn of testRun.turns) expect(content.equals(turn.audio), name).toBe(false);
        continue;
      }
      const body = content.toString("utf8");
      for (const value of forbidden) expect(body.includes(value), `${name} contains ${value}`).toBe(false);
    }
    // Asked for explicitly, the test session is exported.
    const withTest = await buildExportArchive(t.adminCtx, {
      exportType: "dataset_package",
      filters: { includeTest: true },
    });
    const sessionsWithTest = csvObjects(withTest.files.get("sessions.csv")!.toString("utf8"));
    expect(sessionsWithTest.map((row) => row.session_id).sort()).toEqual([research.session.id, testRun.session.id].sort());
  });

  it("9. the corpus read models agree with what happened", async () => {
    const detail = await corpus.getSessionDetail(t.adminCtx, research.session.id);
    expect(detail.session).toMatchObject({
      id: research.session.id,
      participantCode: research.participantCode,
      mode: "research",
      status: "completed",
      excluded: false,
      flagged: false,
    });
    expect(detail.protocol).toMatchObject({ id: study.protocol.protocol.id, versionNumber: 1 });
    expect(detail.consent?.items.map((item) => [item.itemId, item.accepted])).toEqual([
      ["participation", true],
      ["voice_recording", true],
      ["external_ai_processing", true],
      ["future_reuse", true],
    ]);
    expect(detail.taskSequence.map((task) => [task.taskKey, task.status, task.utteranceIds.length])).toEqual([
      ["invite_friend", "completed", 1],
      ["last_weekend", "completed", 2],
      ["free_topic", "completed", 1],
    ]);
    expect(detail.utterances.map((utterance) => utterance.id)).toEqual(research.turns.map((turn) => turn.utteranceId));
    for (const [index, utterance] of detail.utterances.entries()) {
      const turn = research.turns[index]!;
      expect(utterance).toMatchObject({ ordinal: index + 1, status: "submitted", promptSnapshot: turn.promptText });
      expect(utterance.sourceMedia).toMatchObject({ id: turn.mediaAssetId, sha256: turn.sha256 });
      const verified = utterance.transcripts
        .filter((transcript) => transcript.current?.verifiedAt)
        .map((transcript) => transcript.type)
        .sort();
      expect(verified).toEqual(index === 0 ? ["asr_corrected", "human_dialect", "normalized"] : ["human_dialect", "normalized"]);
      expect(utterance.translationBatches.map((entry) => entry.batch.id)).toEqual([batch.id]);
      const matrix = utterance.translationBatches[0]!;
      expect(matrix.conditions.slice().sort()).toEqual(["default", "preservation"]);
      for (const type of ["asr", "human_dialect", "normalized"] as const) {
        const row = matrix.rows.find((candidate) => candidate.transcriptType === type)!;
        for (const cell of row.cells) {
          expect(cell.translations, `${type} ${cell.conditionKey}`).toHaveLength(1);
          expect(cell.translations[0]!.syntheses).toHaveLength(1);
        }
      }
    }
    expect(detail.questionnaires.background?.answers.map((answer) => [answer.itemKey, answer.value])).toEqual([
      ["age_range", BACKGROUND_ANSWERS.age_range],
      ["region_grew_up", BACKGROUND_ANSWERS.region_grew_up],
    ]);
    expect(detail.questionnaires.post?.answers.map((answer) => [answer.itemKey, answer.value])).toEqual([
      ["naturalness", POST_ANSWERS.naturalness],
      ["comment", POST_ANSWERS.comment],
    ]);

    const dashboard = await corpus.getDashboard(t.adminCtx, study.study.id);
    // Research figures count the research session only.
    expect(dashboard.participants).toMatchObject({ started: 1, consented: 1, completed: 1, withdrawn: 0, abandoned: 0 });
    expect(dashboard.utterancesSubmitted).toBe(4);
    expect(dashboard.sourceAudioDurationMs).toBe(4 * 250);
    expect(dashboard.processingErrors).toEqual({ failedJobs: 0, failedModelRuns: 0, total: 0 });
    expect(dashboard.otherModes.test).toEqual({ sessions: 1, completed: 1, utterances: 4 });
    expect(dashboard.otherModes.demo).toEqual({ sessions: 0, completed: 0, utterances: 0 });
    expect(dashboard.status.protocol).toMatchObject({ id: study.protocol.protocol.id, versionNumber: 1 });
    // Every utterance has verified B and C, so nothing waits for review.
    expect(dashboard.awaitingTranscriptionReview).toBe(0);
  });
});
