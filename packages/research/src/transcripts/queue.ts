// The review queue: utterances with a submitted recording, filtered for
// repetitive transcription work (spec 46, 117, 118, 134).
//
// Filters:
// - mode: research only unless the caller asks for test or demo rows;
// - conditions (combined with AND): unreviewed, b_missing, c_missing,
//   a_star_missing, needs_review, flagged (definitions in the validators file);
// - taskType, protocolVersionId;
// - search: ILIKE against the current transcript revisions, the participant
//   code and the start of the utterance id. PostgreSQL only, nothing is sent to
//   a search service. This is a researcher search aid, not dialect ground truth;
// - region: ILIKE against the stored answer to one background questionnaire
//   item. The item key comes from the request (regionItemKey) and defaults to
//   "region_grew_up". The answer is self-reported text, so this is a plain text
//   match and not a classification of the speaker's dialect.
//
// Order: session start, then task order within the session, then turn. The
// order does not depend on review progress, so it is stable while rows are
// being worked on. Each row carries the ids of its neighbors for "Save & next".
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import {
  protocolTasks,
  protocolVersions,
  questionnaireAnswers,
  questionnaireItems,
  questionnaireResponses,
  researchFlags,
  sessions,
  studies,
  taskPresentations,
  transcriptRevisions,
  transcripts,
  utterances,
} from "@dialect/db";
import { TRANSCRIPT_TYPES, transcriptSchemas, type TranscriptType } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { DEFAULT_ADMIN_TIMEZONE, parseInput, toIso } from "./shared";

const { DEFAULT_REGION_ITEM_KEY, REVIEW_QUEUE_DEFAULT_PAGE_SIZE, REVIEW_QUEUE_MAX_PAGE_SIZE, reviewQueueQuerySchema } =
  transcriptSchemas;

export type ReviewQueueFilters = {
  conditions?: transcriptSchemas.ReviewQueueCondition[];
  taskType?: transcriptSchemas.ReviewQueueQuery["taskType"];
  protocolVersionId?: string;
  // Default ["research"].
  modes?: NonNullable<transcriptSchemas.ReviewQueueQuery["mode"]>;
  search?: string;
  region?: string;
  regionItemKey?: string;
  // Also list utterances that were excluded from analysis. Default false.
  includeExcluded?: boolean;
};

export type ReviewQueuePagination = { page?: number; pageSize?: number };

// Escapes the LIKE wildcards so the search text is matched literally.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// True when the utterance has a transcript of this type with a current revision.
function hasText(type: TranscriptType): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${transcripts} t
    JOIN ${transcriptRevisions} r ON r.transcript_id = t.id AND r.is_current
    WHERE t.utterance_id = ${utterances.id} AND t.type = ${type})`;
}

const openFlagExists = sql`EXISTS (
  SELECT 1 FROM ${researchFlags} f
  WHERE f.resolved_at IS NULL AND (
    (f.entity_type = 'utterance' AND f.entity_id = ${utterances.id})
    OR (f.entity_type = 'transcript' AND f.entity_id IN (
      SELECT t.id FROM ${transcripts} t WHERE t.utterance_id = ${utterances.id}))))`;

function conditionSql(condition: transcriptSchemas.ReviewQueueCondition): SQL {
  switch (condition) {
    case "unreviewed":
      return sql`NOT (${hasText("asr_corrected")} OR ${hasText("human_dialect")} OR ${hasText("normalized")})`;
    case "a_star_missing":
      return sql`NOT ${hasText("asr_corrected")}`;
    case "b_missing":
      return sql`NOT ${hasText("human_dialect")}`;
    case "c_missing":
      return sql`NOT ${hasText("normalized")}`;
    case "needs_review":
      return sql`EXISTS (
        SELECT 1 FROM ${transcripts} t
        WHERE t.utterance_id = ${utterances.id} AND t.status = 'needs_review')`;
    case "flagged":
      return sql`(${utterances.flagged} OR ${openFlagExists})`;
  }
}

// Accepts the parsed query of GET /api/admin/review/queue.
export function queueArgumentsFromQuery(query: transcriptSchemas.ReviewQueueQuery): {
  filters: ReviewQueueFilters;
  pagination: ReviewQueuePagination;
} {
  return {
    filters: {
      conditions: query.condition,
      taskType: query.taskType,
      protocolVersionId: query.protocolVersionId,
      modes: query.mode,
      search: query.search,
      region: query.region,
      regionItemKey: query.regionItemKey,
      includeExcluded: query.includeExcluded,
    },
    pagination: { page: query.page, pageSize: query.pageSize },
  };
}

export async function listReviewQueue(
  ctx: ServiceContext,
  filters: ReviewQueueFilters = {},
  pagination: ReviewQueuePagination = {},
): Promise<transcriptSchemas.ReviewQueueResponse> {
  // One validation path for the service and the route: the query schema.
  const parsed = parseInput(reviewQueueQuerySchema, {
    page: pagination.page ?? 1,
    pageSize: pagination.pageSize ?? REVIEW_QUEUE_DEFAULT_PAGE_SIZE,
    condition: filters.conditions,
    taskType: filters.taskType,
    protocolVersionId: filters.protocolVersionId,
    mode: filters.modes,
    search: filters.search,
    region: filters.region,
    regionItemKey: filters.regionItemKey,
    includeExcluded: filters.includeExcluded === undefined ? undefined : String(filters.includeExcluded),
  });
  const page = parsed.page;
  const pageSize = Math.min(parsed.pageSize, REVIEW_QUEUE_MAX_PAGE_SIZE);
  const modes = parsed.mode && parsed.mode.length > 0 ? parsed.mode : (["research"] as const);

  const where: (SQL | undefined)[] = [
    inArray(sessions.mode, [...modes]),
    parsed.includeExcluded
      ? inArray(utterances.status, ["submitted", "excluded"])
      : eq(utterances.status, "submitted"),
  ];
  for (const condition of new Set(parsed.condition ?? [])) where.push(conditionSql(condition));
  if (parsed.taskType) where.push(eq(protocolTasks.taskType, parsed.taskType));
  if (parsed.protocolVersionId) where.push(eq(sessions.protocolVersionId, parsed.protocolVersionId));
  if (parsed.search) {
    const escaped = escapeLike(parsed.search);
    const pattern = `%${escaped}%`;
    where.push(
      or(
        sql`EXISTS (
          SELECT 1 FROM ${transcripts} t
          JOIN ${transcriptRevisions} r ON r.transcript_id = t.id AND r.is_current
          WHERE t.utterance_id = ${utterances.id} AND r.text ILIKE ${pattern})`,
        ilike(sessions.participantCode, pattern),
        sql`${utterances.id}::text ILIKE ${`${escaped}%`}`,
      ),
    );
  }
  if (parsed.region) {
    const pattern = `%${escapeLike(parsed.region)}%`;
    const itemKey = parsed.regionItemKey ?? DEFAULT_REGION_ITEM_KEY;
    where.push(sql`EXISTS (
      SELECT 1 FROM ${questionnaireAnswers} a
      JOIN ${questionnaireResponses} qr ON qr.id = a.response_id
      JOIN ${questionnaireItems} qi ON qi.id = a.questionnaire_item_id
      WHERE qr.session_id = ${sessions.id} AND qi.item_key = ${itemKey}
        AND (a.value_json #>> '{}') ILIKE ${pattern})`);
  }
  const whereSql = and(...where);

  const [totalRow] = await ctx.db
    .select({ total: count() })
    .from(utterances)
    .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
    .innerJoin(taskPresentations, eq(taskPresentations.id, utterances.taskPresentationId))
    .innerJoin(protocolTasks, eq(protocolTasks.id, taskPresentations.protocolTaskId))
    .where(whereSql);
  const total = totalRow?.total ?? 0;

  // One row before and one after the page are read too, to know the neighbors
  // of the first and last row.
  const offset = (page - 1) * pageSize;
  const windowOffset = Math.max(0, offset - 1);
  const leading = offset - windowOffset;
  const window = await ctx.db
    .select({
      utteranceId: utterances.id,
      sessionId: sessions.id,
      participantCode: sessions.participantCode,
      mode: sessions.mode,
      sessionStatus: sessions.status,
      utteranceStatus: utterances.status,
      taskType: protocolTasks.taskType,
      taskKey: protocolTasks.taskKey,
      taskTitle: taskPresentations.titleSnapshot,
      turnIndex: utterances.turnIndex,
      durationMs: utterances.durationMs,
      submittedAt: utterances.submittedAt,
      utteranceFlagged: utterances.flagged,
    })
    .from(utterances)
    .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
    .innerJoin(taskPresentations, eq(taskPresentations.id, utterances.taskPresentationId))
    .innerJoin(protocolTasks, eq(protocolTasks.id, taskPresentations.protocolTaskId))
    .where(whereSql)
    .orderBy(
      asc(sessions.startedAt),
      asc(sessions.id),
      asc(taskPresentations.sequenceIndex),
      asc(utterances.turnIndex),
      asc(utterances.id),
    )
    .limit(pageSize + leading + 1)
    .offset(windowOffset);

  const pageRows = window.slice(leading, leading + pageSize);
  const utteranceIds = pageRows.map((row) => row.utteranceId);

  const transcriptRows =
    utteranceIds.length === 0
      ? []
      : await ctx.db
          .select({
            id: transcripts.id,
            utteranceId: transcripts.utteranceId,
            type: transcripts.type,
            status: transcripts.status,
            // The outer column is written by name: in a query on one table the
            // query builder would render it without its table, and "id" would
            // then mean r.id inside the subquery.
            hasRevision: sql<boolean>`EXISTS (
              SELECT 1 FROM ${transcriptRevisions} r
              WHERE r.transcript_id = "transcripts"."id" AND r.is_current)`,
          })
          .from(transcripts)
          .where(inArray(transcripts.utteranceId, utteranceIds));
  const transcriptIds = transcriptRows.map((row) => row.id);
  const openFlags =
    utteranceIds.length === 0
      ? []
      : await ctx.db
          .select({ entityType: researchFlags.entityType, entityId: researchFlags.entityId })
          .from(researchFlags)
          .where(
            and(
              isNull(researchFlags.resolvedAt),
              or(
                and(eq(researchFlags.entityType, "utterance"), inArray(researchFlags.entityId, utteranceIds)),
                transcriptIds.length > 0
                  ? and(eq(researchFlags.entityType, "transcript"), inArray(researchFlags.entityId, transcriptIds))
                  : undefined,
              ),
            ),
          );

  const rows: transcriptSchemas.ReviewQueueRow[] = pageRows.map((row, index) => {
    const own = transcriptRows.filter((transcript) => transcript.utteranceId === row.utteranceId);
    const states = Object.fromEntries(
      TRANSCRIPT_TYPES.map((type) => {
        const transcript = own.find((candidate) => candidate.type === type);
        return [
          type,
          transcript
            ? { transcriptId: transcript.id, status: transcript.status, hasRevision: transcript.hasRevision }
            : null,
        ];
      }),
    ) as Record<TranscriptType, transcriptSchemas.ReviewQueueTranscriptState | null>;
    const openFlagCount = openFlags.filter(
      (flag) =>
        (flag.entityType === "utterance" && flag.entityId === row.utteranceId) ||
        (flag.entityType === "transcript" && own.some((transcript) => transcript.id === flag.entityId)),
    ).length;
    const position = leading + index;
    return {
      utteranceId: row.utteranceId,
      sessionId: row.sessionId,
      participantCode: row.participantCode,
      mode: row.mode,
      sessionStatus: row.sessionStatus,
      utteranceStatus: row.utteranceStatus,
      taskType: row.taskType,
      taskKey: row.taskKey,
      taskTitle: row.taskTitle,
      turnIndex: row.turnIndex,
      durationMs: row.durationMs,
      submittedAt: toIso(row.submittedAt),
      transcripts: states,
      flagged: row.utteranceFlagged || openFlagCount > 0,
      openFlagCount,
      previousId: window[position - 1]?.utteranceId ?? null,
      nextId: window[position + 1]?.utteranceId ?? null,
    };
  });

  const versions = await ctx.db
    .select({
      id: protocolVersions.id,
      versionNumber: protocolVersions.versionNumber,
      name: protocolVersions.name,
      status: protocolVersions.status,
    })
    .from(protocolVersions)
    .where(ne(protocolVersions.status, "draft"))
    .orderBy(desc(protocolVersions.versionNumber));
  const [study] = await ctx.db
    .select({ settings: studies.settingsJson })
    .from(studies)
    .orderBy(asc(studies.createdAt))
    .limit(1);

  return {
    rows,
    page,
    pageSize,
    total,
    protocolVersions: versions,
    adminTimezone: study?.settings.adminTimezone ?? DEFAULT_ADMIN_TIMEZONE,
  };
}
