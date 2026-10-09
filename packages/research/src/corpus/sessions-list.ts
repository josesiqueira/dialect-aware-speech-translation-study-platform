// Sessions list (spec 43, 117, 134): one SQL query for the page, with the
// aggregates of every row computed in the database. No query per row.
import { asc, eq, sql, type SQL } from "drizzle-orm";
import { protocolVersions } from "@dialect/db";
import { corpusSchemas, type SessionStatus, type StudyMode } from "@dialect/domain";
import type { ServiceContext } from "../context";
import {
  MODEL_RUN_UNRESOLVED_FAILURE,
  MODEL_RUN_UTTERANCE_ID,
  MODEL_RUN_UTTERANCE_JOINS,
  adminTimezoneOf,
  escapeLike,
  parseInput,
  resolveStudy,
  sqlTimeToIso,
} from "./shared";

export type ListSessionsFilters = corpusSchemas.SessionListFilters & { studyId?: string };
export type ListSessionsPagination = corpusSchemas.SessionListPagination;

type Row = {
  id: string;
  participant_code: string;
  started_at: string;
  completed_at: string | null;
  protocol_version_id: string;
  protocol_version_number: number;
  mode: StudyMode;
  status: SessionStatus;
  flagged: boolean;
  excluded: boolean;
  tasks_total: string;
  tasks_completed: string;
  utterance_count: string;
  audio_duration_ms: string;
  verified_b: string;
  verified_c: string;
  flagged_utterances: string;
  excluded_utterances: string;
  error_count: string;
  total: string;
};

const ISO = (column: SQL): SQL => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const SORT_COLUMNS: Record<corpusSchemas.SessionSortKey, SQL> = {
  started_at: sql`s.started_at`,
  completed_at: sql`s.completed_at`,
  participant_code: sql`s.participant_code`,
  status: sql`s.status`,
  utterance_count: sql`agg.utterance_count`,
  audio_duration: sql`agg.audio_duration_ms`,
};

export async function listSessions(
  ctx: ServiceContext,
  filters: ListSessionsFilters = {},
  pagination: ListSessionsPagination = {},
): Promise<corpusSchemas.SessionListResult> {
  const { studyId, ...rest } = filters;
  // Service callers pass typed values, the query string carries text: both are
  // validated by the same schema.
  const query = parseInput(corpusSchemas.sessionListQuerySchema, {
    ...Object.fromEntries(
      Object.entries(rest)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value]) => [key, typeof value === "boolean" ? String(value) : value]),
    ),
    ...Object.fromEntries(Object.entries(pagination).filter(([, value]) => value !== undefined)),
  });
  const study = await resolveStudy(ctx.db, studyId);
  const timezone = adminTimezoneOf(study.settingsJson);

  // Verified B and C per utterance, then the totals per session.
  const reviewComplete = sql`(agg.utterance_count > 0 AND agg.verified_b = agg.utterance_count AND agg.verified_c = agg.utterance_count)`;

  const conditions: SQL[] = [sql`s.study_id = ${study.id}`];
  if (query.search) {
    const term = escapeLike(query.search);
    conditions.push(
      sql`(s.participant_code ILIKE ${`%${term}%`} OR s.id::text ILIKE ${`${term.toLowerCase()}%`})`,
    );
  }
  if (query.dateFrom) {
    conditions.push(sql`s.started_at >= (${query.dateFrom}::date::timestamp AT TIME ZONE ${timezone})`);
  }
  if (query.dateTo) {
    conditions.push(sql`s.started_at < ((${query.dateTo}::date + 1)::timestamp AT TIME ZONE ${timezone})`);
  }
  if (query.protocolVersionId) conditions.push(sql`s.protocol_version_id = ${query.protocolVersionId}`);
  if (query.mode) conditions.push(sql`s.mode = ${query.mode}::study_mode`);
  if (query.completion === "completed") conditions.push(sql`s.status = 'completed'`);
  if (query.completion === "incomplete") conditions.push(sql`s.status <> 'completed'`);
  if (query.flagged === true) conditions.push(sql`(s.flagged OR agg.flagged_utterances > 0)`);
  if (query.flagged === false) conditions.push(sql`NOT (s.flagged OR agg.flagged_utterances > 0)`);
  if (query.hasProcessingErrors === true) conditions.push(sql`coalesce(err.error_count, 0) > 0`);
  if (query.hasProcessingErrors === false) conditions.push(sql`coalesce(err.error_count, 0) = 0`);
  if (query.review === "complete") conditions.push(reviewComplete);
  if (query.review === "incomplete") conditions.push(sql`NOT ${reviewComplete}`);
  if (query.excluded !== undefined) conditions.push(query.excluded ? sql`s.excluded` : sql`NOT s.excluded`);

  const direction = query.direction === "asc" ? sql`ASC` : sql`DESC`;
  const offset = (query.page - 1) * query.pageSize;

  const result = await ctx.db.execute<Row>(sql`
    WITH run_errors AS (
      SELECT eu.session_id, count(*) AS error_count
      FROM model_runs mr
      ${MODEL_RUN_UTTERANCE_JOINS}
      JOIN utterances eu ON eu.id = ${MODEL_RUN_UTTERANCE_ID}
      WHERE ${MODEL_RUN_UNRESOLVED_FAILURE}
      GROUP BY eu.session_id
    ), job_errors AS (
      SELECT ju.session_id, count(*) AS error_count
      FROM jobs j
      JOIN utterances ju ON ju.id::text = j.payload_json->>'utteranceId'
      WHERE j.status = 'failed'
      GROUP BY ju.session_id
    ), err AS (
      SELECT session_id, sum(error_count) AS error_count
      FROM (SELECT * FROM run_errors UNION ALL SELECT * FROM job_errors) all_errors
      GROUP BY session_id
    )
    SELECT
      s.id,
      s.participant_code,
      ${ISO(sql`s.started_at`)} AS started_at,
      ${ISO(sql`s.completed_at`)} AS completed_at,
      s.protocol_version_id,
      pv.version_number AS protocol_version_number,
      s.mode,
      s.status,
      s.flagged,
      s.excluded,
      greatest(tp.total, pt.enabled) AS tasks_total,
      tp.completed AS tasks_completed,
      agg.utterance_count,
      agg.audio_duration_ms,
      agg.verified_b,
      agg.verified_c,
      agg.flagged_utterances,
      agg.excluded_utterances,
      coalesce(err.error_count, 0) AS error_count,
      count(*) OVER () AS total
    FROM sessions s
    JOIN protocol_versions pv ON pv.id = s.protocol_version_id
    LEFT JOIN err ON err.session_id = s.id
    CROSS JOIN LATERAL (
      SELECT count(*) AS total, count(*) FILTER (WHERE p.status = 'completed') AS completed
      FROM task_presentations p WHERE p.session_id = s.id
    ) tp
    CROSS JOIN LATERAL (
      SELECT count(*) AS enabled FROM protocol_tasks t
      WHERE t.protocol_version_id = s.protocol_version_id AND t.enabled
    ) pt
    CROSS JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE u.status = 'submitted') AS utterance_count,
        coalesce(sum(u.duration_ms) FILTER (WHERE u.status = 'submitted'), 0) AS audio_duration_ms,
        count(*) FILTER (WHERE u.status = 'submitted' AND EXISTS (
          SELECT 1 FROM transcripts t
          WHERE t.utterance_id = u.id AND t.type = 'human_dialect' AND t.status = 'verified')) AS verified_b,
        count(*) FILTER (WHERE u.status = 'submitted' AND EXISTS (
          SELECT 1 FROM transcripts t
          WHERE t.utterance_id = u.id AND t.type = 'normalized' AND t.status = 'verified')) AS verified_c,
        -- The flag on the row, or an open flag added on the Review page.
        count(*) FILTER (WHERE (u.flagged OR EXISTS (
          SELECT 1 FROM research_flags f
          WHERE f.entity_type = 'utterance' AND f.entity_id = u.id AND f.resolved_at IS NULL))) AS flagged_utterances,
        count(*) FILTER (WHERE u.status = 'excluded') AS excluded_utterances
      FROM utterances u WHERE u.session_id = s.id
    ) agg
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY ${SORT_COLUMNS[query.sort]} ${direction} NULLS LAST, s.id ${direction}
    LIMIT ${query.pageSize} OFFSET ${offset}`);

  let total = Number(result.rows[0]?.total ?? 0);
  if (result.rows.length === 0 && offset > 0) {
    // A page past the end has no row to carry the window count.
    const counted = await listSessions(ctx, filters, { ...pagination, page: 1, pageSize: 1 });
    total = counted.total;
  }

  const protocolRows = await ctx.db
    .select({ id: protocolVersions.id, versionNumber: protocolVersions.versionNumber, name: protocolVersions.name })
    .from(protocolVersions)
    .where(eq(protocolVersions.studyId, study.id))
    .orderBy(asc(protocolVersions.versionNumber));

  return {
    items: result.rows.map((row) => {
      const utteranceCount = Number(row.utterance_count);
      const verifiedB = Number(row.verified_b);
      const verifiedC = Number(row.verified_c);
      return {
        id: row.id,
        participantCode: row.participant_code,
        startedAt: sqlTimeToIso(row.started_at),
        completedAt: sqlTimeToIso(row.completed_at),
        protocolVersionId: row.protocol_version_id,
        protocolVersionNumber: Number(row.protocol_version_number),
        mode: row.mode,
        status: row.status,
        tasksCompleted: Number(row.tasks_completed),
        tasksTotal: Number(row.tasks_total),
        utteranceCount,
        audioDurationMs: Number(row.audio_duration_ms),
        review: {
          verifiedB,
          verifiedC,
          complete: utteranceCount > 0 && verifiedB === utteranceCount && verifiedC === utteranceCount,
        },
        flagged: row.flagged,
        flaggedUtterances: Number(row.flagged_utterances),
        excluded: row.excluded,
        excludedUtterances: Number(row.excluded_utterances),
        processingErrors: Number(row.error_count),
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort,
    direction: query.direction,
    adminTimezone: timezone,
    protocolVersions: protocolRows,
  };
}
