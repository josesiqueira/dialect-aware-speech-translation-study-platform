// Dashboard read model (spec 42, 108, 119, 154).
//
// Operational study health only. This file must never compute a comparison of
// translation conditions, an effect size or any other hypothesis-related
// outcome, and it shows no participant background data. Research counts cover
// sessions with mode "research" only; demo and test sessions are reported
// separately in `otherModes`.
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  aiPromptVersions,
  jobs,
  modelConfigs,
  modelRuns,
  processingBatches,
  protocolVersions,
  sessions,
  transcriptRevisions,
  transcripts,
  utterances,
} from "@dialect/db";
import type { StudyMode, corpusSchemas } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { getQueueStats, getWorkerStatus } from "../jobs";
import { EXAMPLE_TEXT_STATUS_MESSAGE, currentProtocolExampleText } from "../protocols";
import {
  MODEL_RUN_UNRESOLVED_FAILURE,
  WORKER_STALE_AFTER_MS,
  adminTimezoneOf,
  loadStudy,
  sqlTimeToIso,
  toIso,
  truncate,
} from "./shared";

const RECENT_LIMIT = 8;
const DEFAULT_CHART_DAYS = 14;
const MAX_CHART_DAYS = 90;
const HEALTH_CHECK_TIMEOUT_MS = 5000;

type SessionCountRow = {
  mode: StudyMode;
  started: string;
  consented: string;
  completed: string;
  abandoned: string;
  withdrawn: string;
  flagged: string;
  excluded: string;
  today: string;
};

type UtteranceCountRow = {
  mode: StudyMode;
  submitted: string;
  duration_ms: string;
  flagged: string;
  excluded: string;
  awaiting: string;
};

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), HEALTH_CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function checkStorage(ctx: ServiceContext): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const result = await withTimeout(ctx.storage.healthCheck(), { ok: false, detail: "the storage check timed out" });
    return { ok: result.ok, detail: result.detail ?? null };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "the storage check failed" };
  }
}

export async function checkDatabase(ctx: ServiceContext): Promise<boolean> {
  try {
    await ctx.db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export async function getDashboard(
  ctx: ServiceContext,
  studyId: string,
  options: { days?: number } = {},
): Promise<corpusSchemas.Dashboard> {
  const study = await loadStudy(ctx.db, studyId);
  const settings = study.settingsJson ?? {};
  const timezone = adminTimezoneOf(settings);
  const now = ctx.now();
  const nowIso = now.toISOString();
  const days = Math.min(MAX_CHART_DAYS, Math.max(1, Math.trunc(options.days ?? DEFAULT_CHART_DAYS)));

  const sessionCounts = await ctx.db.execute<SessionCountRow>(sql`
    SELECT mode,
      count(*) AS started,
      count(*) FILTER (WHERE consented_at IS NOT NULL) AS consented,
      count(*) FILTER (WHERE status = 'completed') AS completed,
      count(*) FILTER (WHERE status = 'abandoned') AS abandoned,
      count(*) FILTER (WHERE status = 'withdrawn') AS withdrawn,
      count(*) FILTER (WHERE flagged) AS flagged,
      count(*) FILTER (WHERE excluded) AS excluded,
      count(*) FILTER (
        WHERE (started_at AT TIME ZONE ${timezone})::date = (${nowIso}::timestamptz AT TIME ZONE ${timezone})::date
      ) AS today
    FROM sessions
    WHERE study_id = ${studyId}
      -- A research session that ended before consent was recorded holds no study
      -- data (a declined consent, a page that was opened and left, or a session
      -- created by a script). It is not counted as a participant.
      AND NOT (mode = 'research' AND status = 'abandoned' AND consented_at IS NULL)
    GROUP BY mode`);

  const utteranceCounts = await ctx.db.execute<UtteranceCountRow>(sql`
    SELECT s.mode,
      count(*) FILTER (WHERE u.submitted_at IS NOT NULL AND u.status IN ('submitted', 'excluded')) AS submitted,
      coalesce(sum(u.duration_ms) FILTER (
        WHERE u.submitted_at IS NOT NULL AND u.status IN ('submitted', 'excluded')), 0) AS duration_ms,
      count(*) FILTER (WHERE (u.flagged OR EXISTS (
          SELECT 1 FROM research_flags f
          WHERE f.entity_type = 'utterance' AND f.entity_id = u.id AND f.resolved_at IS NULL))) AS flagged,
      count(*) FILTER (WHERE u.status = 'excluded') AS excluded,
      count(*) FILTER (
        WHERE u.status = 'submitted' AND NOT s.excluded AND NOT (
          EXISTS (SELECT 1 FROM transcripts t
                  WHERE t.utterance_id = u.id AND t.type = 'human_dialect' AND t.status = 'verified')
          AND EXISTS (SELECT 1 FROM transcripts t
                      WHERE t.utterance_id = u.id AND t.type = 'normalized' AND t.status = 'verified')
        )
      ) AS awaiting
    FROM utterances u
    JOIN sessions s ON s.id = u.session_id
    WHERE s.study_id = ${studyId}
    GROUP BY s.mode`);

  const sessionsByMode = new Map(sessionCounts.rows.map((row) => [row.mode, row]));
  const utterancesByMode = new Map(utteranceCounts.rows.map((row) => [row.mode, row]));
  const research = sessionsByMode.get("research");
  const researchUtterances = utterancesByMode.get("research");
  const started = Number(research?.started ?? 0);
  const completed = Number(research?.completed ?? 0);
  const abandoned = Number(research?.abandoned ?? 0);
  const withdrawn = Number(research?.withdrawn ?? 0);

  const modeCounts = (mode: StudyMode): corpusSchemas.ModeCounts => ({
    sessions: Number(sessionsByMode.get(mode)?.started ?? 0),
    completed: Number(sessionsByMode.get(mode)?.completed ?? 0),
    utterances: Number(utterancesByMode.get(mode)?.submitted ?? 0),
  });

  const failedRuns = await ctx.db.execute<{ total: string }>(sql`
    SELECT count(*) AS total FROM model_runs mr WHERE ${MODEL_RUN_UNRESOLVED_FAILURE}`);
  const failedModelRuns = Number(failedRuns.rows[0]?.total ?? 0);

  const [queue, worker, storage, databaseOk] = await Promise.all([
    getQueueStats(ctx.db, { now }),
    getWorkerStatus(ctx.db, { now, staleAfterMs: WORKER_STALE_AFTER_MS }),
    checkStorage(ctx),
    checkDatabase(ctx),
  ]);

  const protocolRows = study.currentProtocolVersionId
    ? await ctx.db
        .select({
          id: protocolVersions.id,
          versionNumber: protocolVersions.versionNumber,
          name: protocolVersions.name,
          publishedAt: protocolVersions.publishedAt,
        })
        .from(protocolVersions)
        .where(eq(protocolVersions.id, study.currentProtocolVersionId))
    : [];
  const protocol = protocolRows[0] ?? null;
  const exampleText = await currentProtocolExampleText(ctx, studyId);

  const configRows = await ctx.db
    .select({
      id: modelConfigs.id,
      key: modelConfigs.key,
      stage: modelConfigs.stage,
      conditionKey: modelConfigs.conditionKey,
      versionNumber: modelConfigs.versionNumber,
      provider: modelConfigs.provider,
      modelId: modelConfigs.modelId,
      promptKey: aiPromptVersions.key,
      promptVersionNumber: aiPromptVersions.versionNumber,
    })
    .from(modelConfigs)
    .leftJoin(aiPromptVersions, eq(aiPromptVersions.id, modelConfigs.promptVersionId))
    .where(and(eq(modelConfigs.studyId, studyId), eq(modelConfigs.status, "active")))
    .orderBy(modelConfigs.stage, modelConfigs.key);
  const configsOf = (stage: string): corpusSchemas.ActiveConfigSummary[] =>
    configRows.filter((row) => row.stage === stage);

  const completedSessions = await ctx.db
    .select({
      id: sessions.id,
      participantCode: sessions.participantCode,
      mode: sessions.mode,
      completedAt: sessions.completedAt,
      // The table name is written out: in a query on one table Drizzle renders a
      // column without its table, which inside the subquery would mean u.id.
      utteranceCount: sql<string>`(
        SELECT count(*) FROM utterances u
        WHERE u.session_id = "sessions"."id" AND u.submitted_at IS NOT NULL)`,
    })
    .from(sessions)
    .where(and(eq(sessions.studyId, studyId), eq(sessions.status, "completed"), isNotNull(sessions.completedAt)))
    .orderBy(desc(sessions.completedAt))
    .limit(RECENT_LIMIT);

  const failedRunRows = await ctx.db
    .select({
      id: modelRuns.id,
      stage: modelRuns.stage,
      errorCode: modelRuns.errorCode,
      errorMessage: modelRuns.errorMessage,
      finishedAt: modelRuns.finishedAt,
      startedAt: modelRuns.startedAt,
      batchName: processingBatches.name,
    })
    .from(modelRuns)
    .leftJoin(processingBatches, eq(processingBatches.id, modelRuns.processingBatchId))
    .where(eq(modelRuns.status, "failed"))
    .orderBy(desc(modelRuns.startedAt))
    .limit(RECENT_LIMIT);
  const failedJobRows = await ctx.db
    .select({
      id: jobs.id,
      type: jobs.type,
      lastError: jobs.lastError,
      finishedAt: jobs.finishedAt,
      updatedAt: jobs.updatedAt,
      batchName: processingBatches.name,
    })
    .from(jobs)
    .leftJoin(processingBatches, eq(processingBatches.id, jobs.processingBatchId))
    .where(eq(jobs.status, "failed"))
    .orderBy(desc(jobs.updatedAt))
    .limit(RECENT_LIMIT);
  const recentErrors: corpusSchemas.DashboardRecentError[] = [
    ...failedRunRows.map((row) => ({
      kind: "model_run" as const,
      id: row.id,
      label: row.stage,
      errorCode: row.errorCode,
      message: truncate(row.errorMessage, 200),
      at: toIso(row.finishedAt ?? row.startedAt),
      batchName: row.batchName,
    })),
    ...failedJobRows.map((row) => ({
      kind: "job" as const,
      id: row.id,
      label: row.type,
      errorCode: null,
      message: truncate(row.lastError, 200),
      at: toIso(row.finishedAt ?? row.updatedAt),
      batchName: row.batchName,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, RECENT_LIMIT);

  const verificationRows = await ctx.db
    .select({
      revisionId: transcriptRevisions.id,
      transcriptType: transcripts.type,
      utteranceId: utterances.id,
      sessionId: sessions.id,
      participantCode: sessions.participantCode,
      mode: sessions.mode,
      verifiedAt: transcriptRevisions.verifiedAt,
      verifiedByLabel: transcriptRevisions.verifiedByLabel,
    })
    .from(transcriptRevisions)
    .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
    .innerJoin(utterances, eq(utterances.id, transcripts.utteranceId))
    .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
    .where(and(eq(sessions.studyId, studyId), isNotNull(transcriptRevisions.verifiedAt)))
    .orderBy(desc(transcriptRevisions.verifiedAt))
    .limit(RECENT_LIMIT);

  const batchRows = await ctx.db
    .select({
      id: processingBatches.id,
      name: processingBatches.name,
      status: processingBatches.status,
      dataMode: processingBatches.dataMode,
      createdAt: processingBatches.createdAt,
      startedAt: processingBatches.startedAt,
      completedAt: processingBatches.completedAt,
    })
    .from(processingBatches)
    .where(eq(processingBatches.studyId, studyId))
    .orderBy(desc(processingBatches.createdAt))
    .limit(RECENT_LIMIT);

  const perDay = await ctx.db.execute<{ date: string; research: string; demo: string; test: string }>(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
      count(s.id) FILTER (WHERE s.mode = 'research') AS research,
      count(s.id) FILTER (WHERE s.mode = 'demo') AS demo,
      count(s.id) FILTER (WHERE s.mode = 'test') AS test
    FROM generate_series(
      (${nowIso}::timestamptz AT TIME ZONE ${timezone})::date - ${days - 1}::int,
      (${nowIso}::timestamptz AT TIME ZONE ${timezone})::date,
      interval '1 day'
    ) AS d(day)
    LEFT JOIN sessions s
      ON s.study_id = ${studyId} AND (s.started_at AT TIME ZONE ${timezone})::date = d.day::date
      AND NOT (s.mode = 'research' AND s.status = 'abandoned' AND s.consented_at IS NULL)
    GROUP BY d.day
    ORDER BY d.day`);

  // Not set means closed, as in sessions/settings.ts.
  const allowNewSessions = settings.allowNewSessions === true;
  const maintenanceMode = settings.maintenanceMode ?? false;
  const lastSeen = worker.workers[0]?.lastSeenAt ?? null;

  return {
    generatedAt: nowIso,
    adminTimezone: timezone,
    study: {
      id: study.id,
      name: study.name,
      status: study.status,
      allowNewSessions,
      maintenanceMode,
      acceptingNewSessions: study.status === "active" && allowNewSessions && !maintenanceMode,
    },
    participants: {
      started,
      consented: Number(research?.consented ?? 0),
      completed,
      abandoned,
      withdrawn,
      inProgress: Math.max(0, started - completed - abandoned - withdrawn),
      completionRate: started > 0 ? completed / started : null,
    },
    sessionsToday: Number(research?.today ?? 0),
    utterancesSubmitted: Number(researchUtterances?.submitted ?? 0),
    sourceAudioDurationMs: Number(researchUtterances?.duration_ms ?? 0),
    awaitingTranscriptionReview: Number(researchUtterances?.awaiting ?? 0),
    processingErrors: { failedJobs: queue.failed, failedModelRuns, total: queue.failed + failedModelRuns },
    flagged: { sessions: Number(research?.flagged ?? 0), utterances: Number(researchUtterances?.flagged ?? 0) },
    excluded: { sessions: Number(research?.excluded ?? 0), utterances: Number(researchUtterances?.excluded ?? 0) },
    otherModes: { demo: modeCounts("demo"), test: modeCounts("test") },
    status: {
      protocol: protocol ? { ...protocol, publishedAt: toIso(protocol.publishedAt) } : null,
      configs: { asr: configsOf("asr"), translation: configsOf("translation"), tts: configsOf("tts") },
      worker: { healthy: worker.healthy, workerCount: worker.workers.length, lastSeenAt: toIso(lastSeen) },
      queue: { queued: queue.queued, running: queue.running, failed: queue.failed },
      storage: { ok: storage.ok, driver: ctx.storage.driver },
      database: { ok: databaseOk },
      exampleText: {
        present: exampleText.present,
        fields: exampleText.fields.map((entry) => entry.label),
        message: exampleText.present ? EXAMPLE_TEXT_STATUS_MESSAGE : null,
      },
    },
    recent: {
      completedSessions: completedSessions.map((row) => ({
        id: row.id,
        participantCode: row.participantCode,
        mode: row.mode,
        completedAt: sqlTimeToIso(row.completedAt as Date),
        utteranceCount: Number(row.utteranceCount),
      })),
      processingErrors: recentErrors,
      transcriptVerifications: verificationRows.map((row) => ({
        ...row,
        verifiedAt: toIso(row.verifiedAt as Date),
      })),
      batches: batchRows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
        startedAt: toIso(row.startedAt),
        completedAt: toIso(row.completedAt),
      })),
    },
    sessionsPerDay: perDay.rows.map((row) => ({
      date: row.date,
      research: Number(row.research),
      demo: Number(row.demo),
      test: Number(row.test),
    })),
  };
}
