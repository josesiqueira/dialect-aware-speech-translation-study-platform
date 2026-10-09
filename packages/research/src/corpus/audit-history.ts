// Reading the append-only admin audit log (spec 37.26, 44 "View audit history").
import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { adminAuditLog, sessions } from "@dialect/db";
import { AppError, corpusSchemas } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { adminTimezoneOf, parseInput, resolveStudy, toIso } from "./shared";

export type AuditHistoryInput = {
  entityType?: string;
  entityId?: string;
  action?: string;
  pagination?: { page?: number; pageSize?: number };
};

type AuditRow = typeof adminAuditLog.$inferSelect;

function toView(row: AuditRow): corpusSchemas.AuditEntryView {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.beforeJson ?? null,
    after: row.afterJson ?? null,
    actorLabel: row.actorLabel,
    createdAt: toIso(row.createdAt),
  };
}

async function readPage(
  ctx: ServiceContext,
  where: SQL | undefined,
  page: number,
  pageSize: number,
): Promise<corpusSchemas.AuditHistoryResult> {
  const study = await resolveStudy(ctx.db).catch(() => null);
  const rows = await ctx.db
    .select()
    .from(adminAuditLog)
    .where(where)
    .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [totals] = await ctx.db.select({ total: count() }).from(adminAuditLog).where(where);
  return {
    items: rows.map(toView),
    total: totals?.total ?? 0,
    page,
    pageSize,
    adminTimezone: adminTimezoneOf(study?.settingsJson),
  };
}

// The audit log, newest first, optionally limited to one entity type, one
// entity or one action.
export async function getAuditHistory(
  ctx: ServiceContext,
  input: AuditHistoryInput = {},
): Promise<corpusSchemas.AuditHistoryResult> {
  const query = parseInput(corpusSchemas.auditQuerySchema, {
    ...(input.entityType ? { entityType: input.entityType } : {}),
    ...(input.entityId ? { entityId: input.entityId } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.pagination?.page !== undefined ? { page: input.pagination.page } : {}),
    ...(input.pagination?.pageSize !== undefined ? { pageSize: input.pagination.pageSize } : {}),
  });
  const where = and(
    query.entityType ? eq(adminAuditLog.entityType, query.entityType) : undefined,
    query.entityId ? eq(adminAuditLog.entityId, query.entityId) : undefined,
    query.action ? eq(adminAuditLog.action, query.action) : undefined,
  );
  return readPage(ctx, where, query.page, query.pageSize);
}

// Every audit entry about one session and the records below it: its utterances,
// recordings, transcripts, transcript revisions, translations and syntheses.
export async function getSessionAuditHistory(
  ctx: ServiceContext,
  sessionId: string,
  pagination: { page?: number; pageSize?: number } = {},
): Promise<corpusSchemas.AuditHistoryResult> {
  const query = parseInput(corpusSchemas.auditQuerySchema, {
    ...(pagination.page !== undefined ? { page: pagination.page } : {}),
    ...(pagination.pageSize !== undefined ? { pageSize: pagination.pageSize } : {}),
  });
  const [session] = await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId));
  if (!session) throw new AppError("NOT_FOUND", "The session does not exist.", { sessionId });

  const where = sql`${adminAuditLog.entityId} IN (
    SELECT ${sessionId}::uuid
    UNION SELECT u.id FROM utterances u WHERE u.session_id = ${sessionId}
    UNION SELECT m.id FROM media_assets m WHERE m.session_id = ${sessionId}
    UNION SELECT t.id FROM transcripts t
      JOIN utterances u ON u.id = t.utterance_id WHERE u.session_id = ${sessionId}
    UNION SELECT r.id FROM transcript_revisions r
      JOIN transcripts t ON t.id = r.transcript_id
      JOIN utterances u ON u.id = t.utterance_id WHERE u.session_id = ${sessionId}
    UNION SELECT tl.id FROM translations tl
      JOIN transcript_revisions r ON r.id = tl.source_transcript_revision_id
      JOIN transcripts t ON t.id = r.transcript_id
      JOIN utterances u ON u.id = t.utterance_id WHERE u.session_id = ${sessionId}
    UNION SELECT sy.id FROM syntheses sy
      JOIN translations tl ON tl.id = sy.translation_id
      JOIN transcript_revisions r ON r.id = tl.source_transcript_revision_id
      JOIN transcripts t ON t.id = r.transcript_id
      JOIN utterances u ON u.id = t.utterance_id WHERE u.session_id = ${sessionId}
  )`;
  return readPage(ctx, where, query.page, query.pageSize);
}
