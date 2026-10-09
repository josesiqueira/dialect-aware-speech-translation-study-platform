// Shared helpers of the protocol services: row types, row loading with locks,
// the draft check and the optimistic concurrency check.
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  consentVersions,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireItems,
  questionnaireVersions,
  studies,
  type DbOrTx,
  type ProtocolOrderConfig,
} from "@dialect/db";
import { AppError } from "@dialect/domain";

export type StudyRow = typeof studies.$inferSelect;
export type ProtocolVersionRow = typeof protocolVersions.$inferSelect;
export type ProtocolTaskRow = typeof protocolTasks.$inferSelect;
export type ProtocolTaskFollowupRow = typeof protocolTaskFollowups.$inferSelect;
export type ConsentVersionRow = typeof consentVersions.$inferSelect;
export type QuestionnaireVersionRow = typeof questionnaireVersions.$inferSelect;
export type QuestionnaireItemRow = typeof questionnaireItems.$inferSelect;

export type TaskWithFollowups = ProtocolTaskRow & { followups: ProtocolTaskFollowupRow[] };

export type QuestionnaireWithItems = QuestionnaireVersionRow & { items: QuestionnaireItemRow[] };

// A protocol version with everything it refers to.
export type ProtocolDetail = {
  protocol: ProtocolVersionRow & {
    // True for the version that new sessions receive.
    isCurrent: boolean;
  };
  // In presentation order: blocks as listed in the order configuration, then
  // order_index. Each task carries its follow-ups in order.
  tasks: TaskWithFollowups[];
  consentVersion: ConsentVersionRow | null;
  backgroundQuestionnaire: QuestionnaireWithItems | null;
  postQuestionnaire: QuestionnaireWithItems | null;
  postReviewQuestionnaire: QuestionnaireWithItems | null;
};

export function one<T>(rows: T[], what = "row"): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`Expected the statement to return a ${what}`);
  return row;
}

// The deployment runs one study. Without an id or a slug this returns the study
// that was created first. The shared implementation is in ../study.ts.
export { resolveStudy } from "../study";

// Locks the study row. Creating a draft and publishing both take this lock, so
// version numbers and the "one draft at a time" rule hold under concurrency.
export async function lockStudy(tx: DbOrTx, studyId: string): Promise<StudyRow> {
  const rows = await tx.select().from(studies).where(eq(studies.id, studyId)).for("update");
  const study = rows[0];
  if (!study) throw new AppError("NOT_FOUND", "The study does not exist.");
  return study;
}

export async function loadProtocol(
  db: DbOrTx,
  id: string,
  options: { lock?: boolean } = {},
): Promise<ProtocolVersionRow> {
  const query = db.select().from(protocolVersions).where(eq(protocolVersions.id, id));
  const rows = options.lock ? await query.for("update") : await query;
  const protocol = rows[0];
  if (!protocol) throw new AppError("NOT_FOUND", "The protocol version does not exist.");
  return protocol;
}

export function protocolLabel(protocol: { versionNumber: number }): string {
  return `Protocol v${protocol.versionNumber}`;
}

// Published and retired versions never change (spec 76, 110). The database
// triggers enforce the same rule; this gives the clear message first.
export function assertDraft(protocol: ProtocolVersionRow): void {
  if (protocol.status !== "draft") {
    throw new AppError(
      "IMMUTABLE_RECORD",
      `${protocolLabel(protocol)} is ${protocol.status} and cannot be edited. Clone it to a new draft and edit the draft.`,
      { protocolVersionId: protocol.id, status: protocol.status },
    );
  }
}

// Optimistic concurrency: the editor sends the updated_at it loaded. A different
// value means someone else saved in between.
export function assertNotStale(protocol: ProtocolVersionRow, expectedUpdatedAt?: string | Date | null): void {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null) return;
  const expected = expectedUpdatedAt instanceof Date ? expectedUpdatedAt : new Date(expectedUpdatedAt);
  if (Number.isNaN(expected.getTime())) {
    throw new AppError("VALIDATION_ERROR", "expectedUpdatedAt is not a valid timestamp.");
  }
  if (expected.getTime() !== protocol.updatedAt.getTime()) {
    throw new AppError(
      "CONFLICT",
      "This draft was changed in another window or by another person after you loaded it. Reload the draft and apply your changes again.",
      { currentUpdatedAt: protocol.updatedAt.toISOString() },
    );
  }
}

// Loads a draft for editing inside a transaction: row lock, draft check,
// concurrency check.
export async function loadDraftForEdit(
  tx: DbOrTx,
  id: string,
  expectedUpdatedAt?: string | Date | null,
): Promise<ProtocolVersionRow> {
  const protocol = await loadProtocol(tx, id, { lock: true });
  assertDraft(protocol);
  assertNotStale(protocol, expectedUpdatedAt);
  return protocol;
}

// Marks the draft as changed. Task and follow-up edits do not touch the
// protocol row themselves, so they call this to move updated_at forward.
// The value written here only has to differ from the stored one: the
// dialect_90_set_updated_at trigger then replaces it with now(), the start time
// of the current transaction.
export async function touchProtocol(tx: DbOrTx, id: string): Promise<void> {
  await tx
    .update(protocolVersions)
    .set({ updatedAt: sql`clock_timestamp()` })
    .where(eq(protocolVersions.id, id));
}

// Presentation order of tasks: blocks in the order of the order configuration
// (a block that is not listed comes last), then order_index, then id.
export function sortTasks<T extends { blockKey: string; orderIndex: number; id: string }>(
  tasks: readonly T[],
  orderConfig: ProtocolOrderConfig | null | undefined,
): T[] {
  const blockPosition = new Map<string, number>();
  for (const [index, block] of (orderConfig?.blocks ?? []).entries()) {
    if (!blockPosition.has(block.key)) blockPosition.set(block.key, index);
  }
  const position = (task: T) => blockPosition.get(task.blockKey) ?? Number.MAX_SAFE_INTEGER;
  return [...tasks].sort(
    (a, b) =>
      position(a) - position(b) ||
      (position(a) === Number.MAX_SAFE_INTEGER ? a.blockKey.localeCompare(b.blockKey) : 0) ||
      a.orderIndex - b.orderIndex ||
      a.id.localeCompare(b.id),
  );
}

export async function loadTasks(
  db: DbOrTx,
  protocol: Pick<ProtocolVersionRow, "id" | "orderConfigJson">,
): Promise<TaskWithFollowups[]> {
  const tasks = await db.select().from(protocolTasks).where(eq(protocolTasks.protocolVersionId, protocol.id));
  const followups =
    tasks.length === 0
      ? []
      : await db
          .select()
          .from(protocolTaskFollowups)
          .where(
            inArray(
              protocolTaskFollowups.protocolTaskId,
              tasks.map((task) => task.id),
            ),
          )
          .orderBy(asc(protocolTaskFollowups.orderIndex), asc(protocolTaskFollowups.id));
  const byTask = new Map<string, ProtocolTaskFollowupRow[]>();
  for (const followup of followups) {
    const list = byTask.get(followup.protocolTaskId) ?? [];
    list.push(followup);
    byTask.set(followup.protocolTaskId, list);
  }
  return sortTasks(tasks, protocol.orderConfigJson).map((task) => ({
    ...task,
    followups: byTask.get(task.id) ?? [],
  }));
}

async function loadQuestionnaire(db: DbOrTx, id: string | null): Promise<QuestionnaireWithItems | null> {
  if (!id) return null;
  const rows = await db.select().from(questionnaireVersions).where(eq(questionnaireVersions.id, id));
  const version = rows[0];
  if (!version) return null;
  const items = await db
    .select()
    .from(questionnaireItems)
    .where(eq(questionnaireItems.questionnaireVersionId, id))
    .orderBy(asc(questionnaireItems.orderIndex), asc(questionnaireItems.id));
  return { ...version, items };
}

export async function loadProtocolDetail(db: DbOrTx, id: string): Promise<ProtocolDetail> {
  const protocol = await loadProtocol(db, id);
  const [study] = await db
    .select({ currentProtocolVersionId: studies.currentProtocolVersionId })
    .from(studies)
    .where(eq(studies.id, protocol.studyId));
  const consentRows = protocol.consentVersionId
    ? await db.select().from(consentVersions).where(eq(consentVersions.id, protocol.consentVersionId))
    : [];
  return {
    protocol: { ...protocol, isCurrent: study?.currentProtocolVersionId === protocol.id },
    tasks: await loadTasks(db, protocol),
    consentVersion: consentRows[0] ?? null,
    backgroundQuestionnaire: await loadQuestionnaire(db, protocol.backgroundQuestionnaireVersionId),
    postQuestionnaire: await loadQuestionnaire(db, protocol.postQuestionnaireVersionId),
    postReviewQuestionnaire: await loadQuestionnaire(db, protocol.postReviewQuestionnaireVersionId),
  };
}

// Text for the audit log: null and undefined are the same "no value".
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T>; keys: Array<keyof T> } {
  const beforeOut: Partial<T> = {};
  const afterOut: Partial<T> = {};
  const keys: Array<keyof T> = [];
  for (const key of Object.keys(after) as Array<keyof T>) {
    const next = after[key];
    if (next === undefined) continue;
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(next ?? null)) continue;
    beforeOut[key] = before[key];
    afterOut[key] = next;
    keys.push(key);
  }
  return { before: beforeOut, after: afterOut, keys };
}
