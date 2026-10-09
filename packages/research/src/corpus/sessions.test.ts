import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questionnaireAnswers, questionnaireResponses } from "@dialect/db";
import {
  insertActiveAiConfigs,
  insertDraftProtocol,
  insertConsentVersion,
  insertModelRun,
  insertQuestionnaire,
  insertSession,
  insertSessionWithUtterance,
  insertStudy,
  insertTaskPresentation,
  insertTranscriptWithRevision,
  insertUtteranceWithMedia,
  publishProtocol,
  type CollectedSession,
} from "@dialect/db/testing-builders";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { captureDetailsOf, getSessionDetail } from "./session-detail";
import { listSessions } from "./sessions-list";
import { processUtterance, type ProcessedUtterance } from "./test-helpers";

let t: TestServiceContext;
let studyId: string;
let protocolId: string;
let full: CollectedSession;
let processed: ProcessedUtterance;
let secondUtteranceId: string;
let incomplete: CollectedSession;
let testSession: CollectedSession;
let demoSession: CollectedSession;

const day = (iso: string) => new Date(iso);

beforeAll(async () => {
  t = await createTestServiceContext();
  const db = t.ctx.db;
  const study = await insertStudy(db, { settingsJson: { adminTimezone: "Europe/Helsinki" } });
  studyId = study.id;

  const consent = await insertConsentVersion(db, { studyId });
  const background = await insertQuestionnaire(db, {
    studyId,
    key: "background",
    items: [
      {
        itemKey: "region",
        type: "single_choice",
        prompt: "Where did you grow up?",
        required: true,
        configJson: { options: [{ value: "north_karelia", label: "North Karelia" }] },
      },
      { itemKey: "comment", type: "free_text", prompt: "Anything else?", required: false },
    ],
  });
  const post = await insertQuestionnaire(db, { studyId, key: "post_recording" });
  const draft = await insertDraftProtocol(db, {
    studyId,
    consentVersionId: consent.id,
    backgroundQuestionnaireVersionId: background.version.id,
    postQuestionnaireVersionId: post.version.id,
    tasks: [
      {
        taskKey: "controlled_1",
        taskType: "controlled",
        title: "Controlled task",
        participantPrompt: "Imagine that you are late for a bus. Tell the driver.",
        contextText: "You are at the bus stop.",
        blockKey: "controlled",
        minDurationSeconds: 3,
      },
      {
        taskKey: "free_1",
        taskType: "free_speech",
        title: "Free speech",
        participantPrompt: "Tell about your home town.",
        blockKey: "free",
      },
    ],
  });
  const protocol = await publishProtocol(db, draft.protocol.id);
  protocolId = protocol.id;
  const base = { studyId, protocolVersionId: protocol.id };
  const ai = await insertActiveAiConfigs(db, { studyId });

  // A complete research session: two tasks, two utterances, questionnaires,
  // transcripts and two processing batches for the first utterance.
  full = await insertSessionWithUtterance(db, {
    ...base,
    session: {
      status: "completed",
      participantCode: "P-FULL0001",
      startedAt: day("2026-10-01T08:00:00.000Z"),
      completedAt: day("2026-10-01T08:30:00.000Z"),
      browserInfoJson: { browserName: "Firefox", os: "Linux" },
      audioEnvironmentJson: { audioContextSampleRate: 48000, captureMethod: "audio_worklet_pcm" },
    },
    utterance: { durationMs: 4000, attemptCount: 2, qualityJson: { peakAmplitude: 0.99, warnings: ["possible_clipping"] } },
    // What the upload service stores of the facts the browser recorder declared.
    media: {
      metadataJson: {
        requestedConstraints: { echoCancellation: false },
        actualTrackSettings: { echoCancellation: true },
        declared: {
          mimeType: "audio/wav",
          mimeTypeMatches: true,
          durationMs: 4000,
          sampleRateHz: 48000,
          channels: 1,
          bitDepth: 16,
          // A raw label as stored by an older version: only its coarse class is returned.
          deviceLabel: "Headset microphone",
          constraintMismatches: [
            { constraint: "echoCancellation", kind: "not_honored", requested: false, actual: true },
            { constraint: "sampleRate", kind: "not_reported", requested: 48000 },
          ],
          inputChannelCount: 2,
          clippedSampleCount: 12,
          peak: 1.02,
          stoppedBy: "max_duration",
        },
      },
    },
  });
  processed = await processUtterance(db, {
    studyId,
    utteranceId: full.utterance.id,
    ai,
    batchNames: ["pilot-v1", "pilot-v2"],
  });
  const secondTask = draft.tasks[1];
  if (!secondTask) throw new Error("missing task");
  const secondPresentation = await insertTaskPresentation(db, {
    sessionId: full.session.id,
    protocolTaskId: secondTask.id,
    status: "completed",
  });
  const second = await insertUtteranceWithMedia(db, {
    sessionId: full.session.id,
    taskPresentationId: secondPresentation.id,
    utterance: { durationMs: 9000 },
  });
  secondUtteranceId = second.utterance.id;
  for (const [version, value] of [
    [background, "north_karelia"],
    [post, 4],
  ] as const) {
    const [response] = await db
      .insert(questionnaireResponses)
      .values({ sessionId: full.session.id, questionnaireVersionId: version.version.id })
      .returning();
    const item = version.items[0];
    if (!response || !item) throw new Error("missing questionnaire rows");
    await db.insert(questionnaireAnswers).values({ responseId: response.id, questionnaireItemId: item.id, valueJson: value });
  }

  // An incomplete research session with an open ASR failure, flagged.
  incomplete = await insertSessionWithUtterance(db, {
    ...base,
    session: {
      status: "recording",
      participantCode: "P-PART0002",
      startedAt: day("2026-10-02T08:00:00.000Z"),
      flagged: true,
    },
    utterance: { durationMs: 500 },
  });
  await insertModelRun(db, {
    stage: "asr",
    sourceEntityType: "utterance",
    sourceEntityId: incomplete.utterance.id,
    status: "failed",
    errorCode: "ASR_PROVIDER_ERROR",
  });

  testSession = await insertSessionWithUtterance(db, {
    ...base,
    session: { mode: "test", status: "completed", participantCode: "P-TEST0003", startedAt: day("2026-10-03T08:00:00.000Z") },
  });
  demoSession = await insertSessionWithUtterance(db, {
    ...base,
    session: {
      mode: "demo",
      status: "completed",
      participantCode: "P-DEMO0004",
      startedAt: day("2026-10-03T22:30:00.000Z"),
      excluded: true,
      exclusionReason: "practice run",
    },
  });
  // A session that never got further than the welcome page.
  await insertSession(db, { ...base, participantCode: "P-NEW00005", startedAt: day("2026-09-30T08:00:00.000Z") });
});

afterAll(async () => {
  await t.cleanup();
});

describe("listSessions", () => {
  const codes = async (filters: Parameters<typeof listSessions>[1], pagination?: Parameters<typeof listSessions>[2]) =>
    (await listSessions(t.adminCtx, { studyId, ...filters }, pagination)).items.map((item) => item.participantCode);

  it("sorts by start time, newest first, 50 rows per page by default", async () => {
    const result = await listSessions(t.adminCtx, { studyId });
    expect(result).toMatchObject({ total: 5, page: 1, pageSize: 50, sort: "started_at", direction: "desc" });
    expect(result.items.map((item) => item.participantCode)).toEqual([
      "P-DEMO0004",
      "P-TEST0003",
      "P-PART0002",
      "P-FULL0001",
      "P-NEW00005",
    ]);
    expect(result.adminTimezone).toBe("Europe/Helsinki");
    expect(result.protocolVersions).toEqual([expect.objectContaining({ id: protocolId })]);
  });

  it("returns the aggregate columns of each session from one query", async () => {
    const result = await listSessions(t.adminCtx, { studyId, search: "P-FULL" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: full.session.id,
      mode: "research",
      status: "completed",
      startedAt: "2026-10-01T08:00:00.000Z",
      completedAt: "2026-10-01T08:30:00.000Z",
      protocolVersionId: protocolId,
      tasksTotal: 2,
      tasksCompleted: 1,
      utteranceCount: 2,
      audioDurationMs: 13_000,
      review: { verifiedB: 1, verifiedC: 1, complete: false },
      flagged: false,
      excluded: false,
      processingErrors: 0,
    });
    // A session that has not reached the tasks yet shows the task count of its protocol.
    const [fresh] = (await listSessions(t.adminCtx, { studyId, search: "P-NEW" })).items;
    expect(fresh).toMatchObject({ tasksTotal: 2, tasksCompleted: 0, utteranceCount: 0 });
  });

  it("paginates on the server and reports the total", async () => {
    const first = await listSessions(t.adminCtx, { studyId }, { page: 1, pageSize: 2 });
    const third = await listSessions(t.adminCtx, { studyId }, { page: 3, pageSize: 2 });
    const beyond = await listSessions(t.adminCtx, { studyId }, { page: 9, pageSize: 2 });
    expect(first.items.map((item) => item.participantCode)).toEqual(["P-DEMO0004", "P-TEST0003"]);
    expect(third.items.map((item) => item.participantCode)).toEqual(["P-NEW00005"]);
    expect(first.total).toBe(5);
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(5);
  });

  it("sorts by other columns in both directions", async () => {
    expect(await codes({}, { sort: "participant_code", direction: "asc" })).toEqual([
      "P-DEMO0004",
      "P-FULL0001",
      "P-NEW00005",
      "P-PART0002",
      "P-TEST0003",
    ]);
    expect((await codes({}, { sort: "audio_duration", direction: "desc" }))[0]).toBe("P-FULL0001");
    expect((await codes({}, { sort: "started_at", direction: "asc" }))[0]).toBe("P-NEW00005");
  });

  it("filters by mode, completion, flag, exclusion, processing errors and review state", async () => {
    expect(await codes({ mode: "research" })).toEqual(["P-PART0002", "P-FULL0001", "P-NEW00005"]);
    expect(await codes({ mode: "test" })).toEqual(["P-TEST0003"]);
    expect(await codes({ mode: "demo" })).toEqual(["P-DEMO0004"]);
    expect(await codes({ completion: "completed" })).toEqual(["P-DEMO0004", "P-TEST0003", "P-FULL0001"]);
    expect(await codes({ completion: "incomplete" })).toEqual(["P-PART0002", "P-NEW00005"]);
    expect(await codes({ flagged: true })).toEqual(["P-PART0002"]);
    expect(await codes({ excluded: true })).toEqual(["P-DEMO0004"]);
    expect(await codes({ excluded: false })).toHaveLength(4);
    expect(await codes({ hasProcessingErrors: true })).toEqual(["P-PART0002"]);
    expect(await codes({ review: "complete" })).toEqual([]);
    expect(await codes({ review: "incomplete" })).toHaveLength(5);
    expect(await codes({ protocolVersionId: protocolId })).toHaveLength(5);
    expect(await codes({ protocolVersionId: "00000000-0000-4000-8000-000000000000" })).toEqual([]);
  });

  it("marks the review as complete when every utterance has verified B and C", async () => {
    await insertTranscriptWithRevision(t.ctx.db, {
      utteranceId: testSession.utterance.id,
      type: "human_dialect",
      status: "verified",
    });
    await insertTranscriptWithRevision(t.ctx.db, {
      utteranceId: testSession.utterance.id,
      type: "normalized",
      status: "verified",
    });
    expect(await codes({ review: "complete" })).toEqual(["P-TEST0003"]);
  });

  it("filters by a date range in the admin time zone", async () => {
    // 22:30 UTC on the 3rd is the 4th in Helsinki.
    expect(await codes({ dateFrom: "2026-10-04" })).toEqual(["P-DEMO0004"]);
    expect(await codes({ dateFrom: "2026-10-01", dateTo: "2026-10-02" })).toEqual(["P-PART0002", "P-FULL0001"]);
    expect(await codes({ dateTo: "2026-09-30" })).toEqual(["P-NEW00005"]);
  });

  it("searches by participant code and by session id", async () => {
    expect(await codes({ search: "part0002" })).toEqual(["P-PART0002"]);
    expect(await codes({ search: full.session.id })).toEqual(["P-FULL0001"]);
    expect(await codes({ search: full.session.id.slice(0, 13) })).toEqual(["P-FULL0001"]);
    expect(await codes({ search: "100%_nothing" })).toEqual([]);
  });

  it("rejects invalid filters", async () => {
    await expect(listSessions(t.adminCtx, { studyId, dateFrom: "yesterday" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(listSessions(t.adminCtx, { studyId }, { pageSize: 5000 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("getSessionDetail", () => {
  it("returns the header, the consent that was given and the capture metadata", async () => {
    const detail = await getSessionDetail(t.adminCtx, full.session.id);
    expect(detail.session).toMatchObject({
      participantCode: "P-FULL0001",
      mode: "research",
      status: "completed",
      startedAt: "2026-10-01T08:00:00.000Z",
      completedAt: "2026-10-01T08:30:00.000Z",
    });
    expect(detail.protocol.id).toBe(protocolId);
    expect(detail.consent).toMatchObject({ versionNumber: 1, title: "Consent to take part" });
    expect(detail.consent?.items).toEqual([
      { itemId: "participation", textSnapshot: "I agree to take part in this study.", required: true, accepted: true, scope: "participation" },
      { itemId: "voice_recording", textSnapshot: "I agree that my voice is recorded.", required: true, accepted: true, scope: "voice_recording" },
      { itemId: "future_reuse", textSnapshot: "My recordings may be reused in later research.", required: false, accepted: true, scope: "future_research_reuse" },
    ]);
    expect(detail.capture).toEqual({
      browserInfo: { browserName: "Firefox", os: "Linux" },
      audioEnvironment: { audioContextSampleRate: 48000, captureMethod: "audio_worklet_pcm" },
    });
  });

  it("returns the recorder facts of the source recording, with the settings the browser did not confirm", async () => {
    const detail = await getSessionDetail(t.adminCtx, full.session.id);
    expect(detail.utterances[0]?.captureDetails).toEqual({
      constraintMismatches: [
        { constraint: "echoCancellation", kind: "not_honored", requested: "false", actual: "true" },
        { constraint: "sampleRate", kind: "not_reported", requested: "48000", actual: null },
      ],
      deviceClass: "headset",
      fallbackReason: null,
      fallbackDetail: null,
      inputChannelCount: 2,
      clippedSampleCount: 12,
      peak: 1.02,
      declaredBitDepth: 16,
      stoppedBy: "max_duration",
    });
  });

  it("returns the coarse device class and never the raw device label", () => {
    // The class as the upload service stores it now, in the field `deviceLabel`.
    expect(captureDetailsOf({ declared: { deviceLabel: "usb" } })?.deviceClass).toBe("usb");
    expect(captureDetailsOf({ declared: { deviceClass: "bluetooth" } })?.deviceClass).toBe("bluetooth");
    // A raw name stored by an older version is reduced to its class.
    const legacy = captureDetailsOf({ declared: { deviceLabel: "Jose's AirPods Pro", inputChannelCount: 1 } });
    expect(legacy?.deviceClass).toBe("bluetooth");
    expect(JSON.stringify(legacy)).not.toContain("AirPods");
    const unrecognized = captureDetailsOf({ declared: { deviceLabel: "Jose's microphone" } });
    expect(unrecognized?.deviceClass).toBe("unknown");
    expect(JSON.stringify(unrecognized)).not.toContain("Jose");
    // Nothing declared about the device.
    expect(captureDetailsOf({ declared: { peak: 0.5 } })?.deviceClass).toBeNull();
  });

  it("reads recorder facts defensively from the free JSON column", () => {
    for (const nothing of [null, undefined, {}, { declared: null }, { declared: "x" }, { declared: { mimeType: "audio/wav", durationMs: 1 } }]) {
      expect(captureDetailsOf(nothing)).toBeNull();
    }
    expect(
      captureDetailsOf({
        declared: {
          fallbackReason: "audio_worklet_failed",
          fallbackDetail: "The worklet did not load.",
          constraintMismatches: [null, "x", { kind: "not_honored" }, { constraint: "autoGainControl" }],
          peak: "loud",
          clippedSampleCount: Number.NaN,
        },
      }),
    ).toEqual({
      constraintMismatches: [{ constraint: "autoGainControl", kind: "not_reported", requested: null, actual: null }],
      deviceClass: null,
      fallbackReason: "audio_worklet_failed",
      fallbackDetail: "The worklet did not load.",
      inputChannelCount: null,
      clippedSampleCount: null,
      peak: null,
      declaredBitDepth: null,
      stoppedBy: null,
    });
  });

  it("returns the exact task sequence and prompt snapshots", async () => {
    const detail = await getSessionDetail(t.adminCtx, full.session.id);
    expect(detail.taskSequence.map((task) => [task.sequenceIndex, task.taskKey, task.taskType, task.promptSnapshot])).toEqual([
      [0, "controlled_1", "controlled", "Imagine that you are late for a bus. Tell the driver."],
      [1, "free_1", "free_speech", "Tell about your home town."],
    ]);
    expect(detail.taskSequence[0]?.contextSnapshot).toBe("You are at the bus stop.");
    expect(detail.taskSequence[0]?.utteranceIds).toEqual([full.utterance.id]);
    expect(detail.utterances.map((utterance) => [utterance.ordinal, utterance.id, utterance.promptSnapshot])).toEqual([
      [1, full.utterance.id, "Imagine that you are late for a bus. Tell the driver."],
      [2, secondUtteranceId, "Tell about your home town."],
    ]);
  });

  it("describes the source recording and the four transcripts of an utterance", async () => {
    const detail = await getSessionDetail(t.adminCtx, full.session.id);
    const utterance = detail.utterances[0];
    expect(utterance).toMatchObject({ attemptCount: 2, status: "submitted", durationMs: 4000 });
    expect(utterance?.sourceMedia).toMatchObject({
      id: full.media.id,
      sha256: full.media.sha256,
      captureSummary: "48 kHz, mono, PCM 16-bit",
      captureQualityClass: "lossless_pcm",
      deletedAt: null,
    });
    expect(JSON.stringify(utterance?.sourceMedia)).not.toContain(full.media.storageKey);
    expect(utterance?.transcripts.map((cell) => [cell.label, cell.status, cell.current?.revisionNumber ?? null])).toEqual([
      ["A", "draft", 1],
      ["A*", "not_started", null],
      ["B", "verified", 1],
      ["C", "verified", 1],
    ]);
    expect(utterance?.transcripts[2]?.current).toMatchObject({
      text: "Mie en oikeestaan tiiä.",
      verifiedByLabel: "JS",
      transcriptionConventionVersion: "1.0",
    });
    // Clipping is reported, B and C are verified, nothing is missing.
    expect(utterance?.qualityIndicators).toEqual(["possible_clipping"]);
    // The second utterance has no transcripts at all.
    expect(detail.utterances[1]?.qualityIndicators).toEqual(["missing_b", "missing_c"]);
  });

  it("returns the translation matrix per batch with the provenance of every cell", async () => {
    const detail = await getSessionDetail(t.adminCtx, full.session.id);
    const batches = detail.utterances[0]?.translationBatches ?? [];
    expect(batches.map((entry) => entry.batch.name)).toEqual(["pilot-v1", "pilot-v2"]);

    const first = batches[0];
    expect(first?.conditions).toEqual(["default", "preservation"]);
    expect(first?.rows.map((row) => row.label)).toEqual(["A", "A*", "B", "C"]);
    expect(first?.rows.map((row) => row.cells.map((cell) => cell.translations.length))).toEqual([
      [1, 1],
      [0, 0],
      [1, 1],
      [1, 1],
    ]);

    const expected = processed.batches[1]?.outputs.find(
      (output) => output.sourceType === "human_dialect" && output.condition === "preservation",
    );
    const cell = batches[1]?.rows[2]?.cells[1]?.translations[0];
    expect(cell).toMatchObject({
      id: expected?.translation.id,
      text: "pilot-v2 human_dialect preservation",
      conditionKey: "preservation",
      status: "generated",
      sourceRevision: {
        id: processed.dialect.revision.id,
        revisionNumber: 1,
        isCurrent: true,
        transcriptType: "human_dialect",
      },
      modelRun: {
        id: expected?.modelRun.id,
        stage: "translation",
        status: "succeeded",
        provider: "mock",
        requestedModel: "mock-translation",
        appVersion: "1.2.3",
        gitCommitSha: "abc1234",
        processingBatchId: processed.batches[1]?.batch.id,
        modelConfig: { key: "translation_preserve", versionNumber: 1 },
        prompt: { key: "translation_preserve", versionNumber: 1 },
      },
    });
    expect(cell?.modelRun.finishedAt).toBeTruthy();
    expect(cell?.syntheses).toHaveLength(1);
    expect(cell?.syntheses[0]).toMatchObject({
      id: expected?.synthesis.synthesis.id,
      voiceKey: "mock-voice",
      sourceText: "pilot-v2 human_dialect preservation",
      media: { id: expected?.synthesis.media.id, sha256: expected?.synthesis.media.sha256, kind: "tts_audio" },
      modelRun: {
        stage: "tts",
        requestedModel: "mock-tts",
        modelConfig: { key: "tts_baseline", versionNumber: 1 },
        prompt: { key: "tts_baseline", versionNumber: 1 },
      },
    });
  });

  it("keeps a translation attached to the revision it was made from", async () => {
    const { session, utterance } = await insertSessionWithUtterance(t.ctx.db, {
      studyId,
      protocolVersionId: protocolId,
      session: { mode: "test", participantCode: "P-REVS0006" },
    });
    const done = await processUtterance(t.ctx.db, {
      studyId,
      utteranceId: utterance.id,
      ai: processed.ai,
      batchNames: ["revision-batch"],
      dataMode: "test",
    });
    await insertTranscriptWithRevision(t.ctx.db, { utteranceId: utterance.id, type: "human_dialect", text: "Corrected." });
    const detail = await getSessionDetail(t.adminCtx, session.id);
    const b = detail.utterances[0]?.transcripts[2];
    expect(b).toMatchObject({ revisionCount: 2, current: { revisionNumber: 2, text: "Corrected." } });
    const translation = detail.utterances[0]?.translationBatches[0]?.rows[2]?.cells[0]?.translations[0];
    expect(translation?.sourceRevision).toMatchObject({
      id: done.dialect.revision.id,
      revisionNumber: 1,
      isCurrent: false,
    });
  });

  it("returns the questionnaire answers with option labels", async () => {
    const detail = await getSessionDetail(t.adminCtx, full.session.id);
    expect(detail.questionnaires.backgroundExpected).toBe(true);
    expect(detail.questionnaires.background?.questionnaire).toMatchObject({ key: "background", versionNumber: 1 });
    expect(detail.questionnaires.background?.answers.map((answer) => [answer.itemKey, answer.value, answer.display])).toEqual([
      ["region", "north_karelia", "North Karelia"],
      ["comment", null, null],
    ]);
    expect(detail.questionnaires.post?.answers[0]).toMatchObject({ itemKey: "naturalness", value: 4, display: "4 (scale 1 to 5)" });
  });

  it("computes the completeness checks", async () => {
    const detail = await getSessionDetail(t.adminCtx, full.session.id);
    const checks = Object.fromEntries(detail.completeness.map((check) => [check.key, check.complete]));
    expect(checks).toEqual({
      source_audio_complete: true,
      background_complete: true,
      post_questionnaire_complete: true,
      // The second utterance has no verified B and C.
      required_transcripts_complete: false,
      processing_complete: true,
    });

    const partial = await getSessionDetail(t.adminCtx, incomplete.session.id);
    const partialChecks = Object.fromEntries(partial.completeness.map((check) => [check.key, check.complete]));
    expect(partialChecks).toEqual({
      source_audio_complete: false,
      background_complete: false,
      post_questionnaire_complete: false,
      required_transcripts_complete: false,
      processing_complete: false,
    });
    expect(partial.completeness[0]?.detail).toContain("1 of 2 tasks");
  });

  it("shows quality indicators and the processing history, including failures", async () => {
    const detail = await getSessionDetail(t.adminCtx, incomplete.session.id);
    // 500 ms is below the 3 second minimum of the task.
    expect(detail.utterances[0]?.qualityIndicators).toEqual(["too_short", "asr_failed", "missing_b", "missing_c"]);
    expect(detail.processing.modelRuns).toEqual([
      expect.objectContaining({
        stage: "asr",
        status: "failed",
        errorCode: "ASR_PROVIDER_ERROR",
        utteranceId: incomplete.utterance.id,
      }),
    ]);

    const fullDetail = await getSessionDetail(t.adminCtx, full.session.id);
    // 2 batches x 3 transcripts x 2 conditions, each with one translation run and one TTS run.
    expect(fullDetail.processing.modelRuns).toHaveLength(24);
    expect(new Set(fullDetail.processing.modelRuns.map((run) => run.utteranceId))).toEqual(new Set([full.utterance.id]));
    expect(new Set(fullDetail.processing.modelRuns.map((run) => run.batchName))).toEqual(new Set(["pilot-v1", "pilot-v2"]));
  });

  it("labels demo and test sessions with their mode", async () => {
    expect((await getSessionDetail(t.adminCtx, testSession.session.id)).session.mode).toBe("test");
    const demo = await getSessionDetail(t.adminCtx, demoSession.session.id);
    expect(demo.session).toMatchObject({ mode: "demo", excluded: true, exclusionReason: "practice run" });
  });

  it("rejects an unknown session", async () => {
    await expect(getSessionDetail(t.adminCtx, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
