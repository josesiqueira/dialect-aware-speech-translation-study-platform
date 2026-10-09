// Editing the tasks and follow-ups of a draft protocol (spec 7, 8, 48).
//
// Rules kept here:
// - Tasks can only be added, changed, moved or removed while the protocol is a
//   draft. The service checks this first; the database triggers are the safety net.
// - task_key is a stable slug, unique within the protocol. It never changes
//   after the task is created and is kept when a protocol is cloned, so the same
//   task can be followed across versions.
// - Task order: blocks in the order of the protocol's order configuration, then
//   order_index. order_index is kept dense (0, 1, 2, ...) over the whole
//   protocol in that presentation order.
// - A task's order_mode always equals the order mode of its block.
// - Follow-ups are predefined texts written by the researcher. There is no
//   model-generated follow-up anywhere (spec 7.2, 82).
// - Every change moves the protocol's updated_at forward and writes one audit row.
import { asc, eq } from "drizzle-orm";
import {
  isUniqueViolation,
  protocolTaskFollowups,
  protocolTasks,
  type DbOrTx,
  type ProtocolOrderConfig,
  type ProtocolTaskConfig,
} from "@dialect/db";
import { AppError, compactTranslations, protocolSchemas } from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import {
  changedFields,
  loadDraftForEdit,
  loadProtocolDetail,
  one,
  sortTasks,
  touchProtocol,
  type ProtocolDetail,
  type ProtocolTaskFollowupRow,
  type ProtocolTaskRow,
  type ProtocolVersionRow,
} from "./shared";

export type TaskInput = protocolSchemas.TaskInput;
export type TaskChanges = protocolSchemas.TaskChanges;
export type FollowupInput = protocolSchemas.FollowupInput;
export type FollowupChanges = protocolSchemas.FollowupChanges;
export type MoveDirection = protocolSchemas.MoveDirection;

export type EditOptions = {
  // The protocol updated_at the editor loaded. Checked when given.
  expectedUpdatedAt?: string | Date;
  // When given, the task or follow-up must belong to this protocol version.
  protocolVersionId?: string;
};

type Tx = DbOrTx;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function uniqueKey(existing: readonly string[], base: string): string {
  if (!existing.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `_${suffix}`;
    const candidate = `${base.slice(0, protocolSchemas.MAX_KEY_LENGTH - tail.length)}${tail}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

function blockOf(orderConfig: ProtocolOrderConfig, key: string) {
  return orderConfig.blocks.find((block) => block.key === key);
}

function requireBlock(orderConfig: ProtocolOrderConfig, key: string) {
  const block = blockOf(orderConfig, key);
  if (!block) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The block "${key}" does not exist in this protocol. Add it under Task blocks first.`,
      { blockKey: key },
    );
  }
  return block;
}

function assertDurations(task: {
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
}): void {
  if (
    task.minDurationSeconds !== null &&
    task.maxDurationSeconds !== null &&
    task.minDurationSeconds > task.maxDurationSeconds
  ) {
    throw new AppError("VALIDATION_ERROR", "The minimum duration cannot be longer than the maximum duration.");
  }
}

function mergeConfig(
  current: ProtocolTaskConfig,
  changes: Pick<TaskChanges, "topicSuggestions" | "followupMode" | "randomizationEligible">,
): ProtocolTaskConfig {
  const next: ProtocolTaskConfig = { ...current };
  if (changes.topicSuggestions !== undefined) {
    if (changes.topicSuggestions.length > 0) next.topicSuggestions = changes.topicSuggestions;
    else delete next.topicSuggestions;
  }
  if (changes.followupMode !== undefined) next.followupMode = changes.followupMode;
  if (changes.randomizationEligible !== undefined) next.randomizationEligible = changes.randomizationEligible;
  return next;
}

async function loadTaskRows(tx: Tx, protocolVersionId: string): Promise<ProtocolTaskRow[]> {
  return tx.select().from(protocolTasks).where(eq(protocolTasks.protocolVersionId, protocolVersionId));
}

// Writes the given presentation order: dense order_index, the block of each
// task, and the order mode of that block. Only rows that differ are updated.
async function writeTaskLayout(
  tx: Tx,
  orderConfig: ProtocolOrderConfig,
  current: readonly ProtocolTaskRow[],
  desired: ReadonlyArray<{ id: string; blockKey: string }>,
): Promise<void> {
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const [index, item] of desired.entries()) {
    const task = byId.get(item.id);
    if (!task) continue;
    const orderMode = blockOf(orderConfig, item.blockKey)?.orderMode ?? task.orderMode;
    if (task.orderIndex !== index || task.blockKey !== item.blockKey || task.orderMode !== orderMode) {
      await tx
        .update(protocolTasks)
        .set({ orderIndex: index, blockKey: item.blockKey, orderMode })
        .where(eq(protocolTasks.id, task.id));
    }
  }
}

// Makes order_index dense in presentation order and aligns each task's order
// mode with its block. Called after every change that can affect the order.
export async function renumberTasks(
  tx: Tx,
  protocolVersionId: string,
  orderConfig: ProtocolOrderConfig,
): Promise<void> {
  const tasks = await loadTaskRows(tx, protocolVersionId);
  await writeTaskLayout(tx, orderConfig, tasks, sortTasks(tasks, orderConfig));
}

async function renumberFollowups(tx: Tx, taskId: string): Promise<void> {
  const followups = await tx
    .select()
    .from(protocolTaskFollowups)
    .where(eq(protocolTaskFollowups.protocolTaskId, taskId))
    .orderBy(asc(protocolTaskFollowups.orderIndex), asc(protocolTaskFollowups.id));
  for (const [index, followup] of followups.entries()) {
    if (followup.orderIndex !== index) {
      await tx
        .update(protocolTaskFollowups)
        .set({ orderIndex: index })
        .where(eq(protocolTaskFollowups.id, followup.id));
    }
  }
}

type TaskScope = { protocol: ProtocolVersionRow; task: ProtocolTaskRow };

// Finds the task, locks its protocol, checks draft status and concurrency, and
// reads the task again under the lock.
async function loadTaskForEdit(tx: Tx, taskId: string, options: EditOptions): Promise<TaskScope> {
  const notFound = () => new AppError("NOT_FOUND", "The task does not exist.");
  const [found] = await tx
    .select({ protocolVersionId: protocolTasks.protocolVersionId })
    .from(protocolTasks)
    .where(eq(protocolTasks.id, taskId));
  if (!found) throw notFound();
  if (options.protocolVersionId && options.protocolVersionId !== found.protocolVersionId) throw notFound();
  const protocol = await loadDraftForEdit(tx, found.protocolVersionId, options.expectedUpdatedAt);
  const [task] = await tx.select().from(protocolTasks).where(eq(protocolTasks.id, taskId));
  if (!task) throw notFound();
  return { protocol, task };
}

async function loadFollowupForEdit(
  tx: Tx,
  followupId: string,
  options: EditOptions & { taskId?: string },
): Promise<TaskScope & { followup: ProtocolTaskFollowupRow }> {
  const notFound = () => new AppError("NOT_FOUND", "The follow-up does not exist.");
  const [found] = await tx
    .select({ protocolTaskId: protocolTaskFollowups.protocolTaskId })
    .from(protocolTaskFollowups)
    .where(eq(protocolTaskFollowups.id, followupId));
  if (!found) throw notFound();
  if (options.taskId && options.taskId !== found.protocolTaskId) throw notFound();
  const scope = await loadTaskForEdit(tx, found.protocolTaskId, options);
  const [followup] = await tx
    .select()
    .from(protocolTaskFollowups)
    .where(eq(protocolTaskFollowups.id, followupId));
  if (!followup) throw notFound();
  return { ...scope, followup };
}

async function auditDraftChange(
  tx: Tx,
  ctx: ServiceContext,
  protocolVersionId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await touchProtocol(tx, protocolVersionId);
  await recordAudit(tx, {
    action: "protocol.update_draft",
    entityType: "protocol_version",
    entityId: protocolVersionId,
    before,
    after,
    actorLabel: ctx.actorLabel,
  });
}

function taskSnapshot(task: ProtocolTaskRow) {
  const { id: _id, protocolVersionId: _protocolVersionId, createdAt: _createdAt, ...rest } = task;
  return rest;
}

function conflictOnKey(error: unknown): never {
  if (
    isUniqueViolation(error, "protocol_tasks_version_key_uq") ||
    isUniqueViolation(error, "protocol_task_followups_task_key_uq")
  ) {
    throw new AppError("CONFLICT", "That key is already used in this protocol. Choose another key.");
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

// Adds a task at the end of its block.
export async function addTask(
  ctx: ServiceContext,
  protocolVersionId: string,
  input: TaskInput,
  options: EditOptions = {},
): Promise<ProtocolDetail> {
  await ctx.db
    .transaction(async (tx) => {
      const protocol = await loadDraftForEdit(tx, protocolVersionId, options.expectedUpdatedAt);
      const block = requireBlock(protocol.orderConfigJson, input.blockKey);
      const existing = await loadTaskRows(tx, protocolVersionId);
      const existingKeys = existing.map((task) => task.taskKey);
      let taskKey: string;
      if (input.taskKey) {
        if (existingKeys.includes(input.taskKey)) {
          throw new AppError("CONFLICT", `The task key "${input.taskKey}" is already used in this protocol.`);
        }
        taskKey = input.taskKey;
      } else {
        const base = protocolSchemas.slugifyKey(input.internalName || input.title || "", input.taskType);
        taskKey = uniqueKey(existingKeys, base);
      }
      const values = {
        protocolVersionId,
        taskKey,
        internalName: input.internalName ?? null,
        taskType: input.taskType,
        title: input.title ?? "",
        participantPrompt: input.participantPrompt ?? "",
        contextText: input.contextText ?? null,
        instructionsText: input.instructionsText ?? null,
        blockKey: block.key,
        orderIndex: existing.reduce((max, task) => Math.max(max, task.orderIndex), -1) + 1,
        orderMode: block.orderMode,
        enabled: input.enabled ?? true,
        minDurationSeconds: input.minDurationSeconds ?? null,
        suggestedDurationSeconds: input.suggestedDurationSeconds ?? null,
        maxDurationSeconds: input.maxDurationSeconds ?? null,
        // Free speech invites personal stories, so the reminder starts switched on (spec 7.3).
        privacyReminder: input.privacyReminder ?? input.taskType === "free_speech",
        researcherNotes: input.researcherNotes ?? null,
        configJson: mergeConfig({}, input),
        translationsJson: compactTranslations(input.translations),
      };
      assertDurations(values);
      const task = one(await tx.insert(protocolTasks).values(values).returning());
      await renumberTasks(tx, protocolVersionId, protocol.orderConfigJson);
      await auditDraftChange(tx, ctx, protocolVersionId, null, { taskAdded: taskSnapshot(task) });
    })
    .catch(conflictOnKey);
  return loadProtocolDetail(ctx.db, protocolVersionId);
}

export async function updateTask(
  ctx: ServiceContext,
  taskId: string,
  changes: TaskChanges,
  options: EditOptions = {},
): Promise<ProtocolDetail> {
  const protocolVersionId = await ctx.db.transaction(async (tx) => {
    const { protocol, task } = await loadTaskForEdit(tx, taskId, options);
    const { topicSuggestions, followupMode, randomizationEligible, translations, ...columns } = changes;
    const next: Partial<ProtocolTaskRow> = { ...columns };
    if (translations !== undefined) next.translationsJson = compactTranslations(translations);
    if (topicSuggestions !== undefined || followupMode !== undefined || randomizationEligible !== undefined) {
      next.configJson = mergeConfig(task.configJson, { topicSuggestions, followupMode, randomizationEligible });
    }
    const movesBlock = columns.blockKey !== undefined && columns.blockKey !== task.blockKey;
    if (movesBlock) {
      const block = requireBlock(protocol.orderConfigJson, columns.blockKey as string);
      const all = await loadTaskRows(tx, protocol.id);
      // Goes to the end of the new block.
      next.orderIndex = all.reduce((max, row) => Math.max(max, row.orderIndex), -1) + 1;
      next.orderMode = block.orderMode;
    }
    assertDurations({
      minDurationSeconds: next.minDurationSeconds !== undefined ? next.minDurationSeconds : task.minDurationSeconds,
      maxDurationSeconds: next.maxDurationSeconds !== undefined ? next.maxDurationSeconds : task.maxDurationSeconds,
    });
    const diff = changedFields(task, next);
    if (diff.keys.length === 0) return protocol.id;
    await tx.update(protocolTasks).set(diff.after).where(eq(protocolTasks.id, taskId));
    if (movesBlock) await renumberTasks(tx, protocol.id, protocol.orderConfigJson);
    const { orderIndex: _beforeIndex, ...before } = diff.before;
    const { orderIndex: _afterIndex, ...after } = diff.after;
    await auditDraftChange(
      tx,
      ctx,
      protocol.id,
      { taskKey: task.taskKey, task: before },
      { taskKey: task.taskKey, task: after },
    );
    return protocol.id;
  });
  return loadProtocolDetail(ctx.db, protocolVersionId);
}

export async function setTaskEnabled(
  ctx: ServiceContext,
  taskId: string,
  enabled: boolean,
  options: EditOptions = {},
): Promise<ProtocolDetail> {
  return updateTask(ctx, taskId, { enabled }, options);
}

// Copies a task with its follow-ups and places the copy right after the
// original. The copy gets a new task key, because it is a different task.
export async function cloneTask(
  ctx: ServiceContext,
  taskId: string,
  options: EditOptions = {},
): Promise<ProtocolDetail> {
  const protocolVersionId = await ctx.db
    .transaction(async (tx) => {
      const { protocol, task } = await loadTaskForEdit(tx, taskId, options);
      const all = await loadTaskRows(tx, protocol.id);
      const taskKey = uniqueKey(
        all.map((row) => row.taskKey),
        `${task.taskKey.slice(0, protocolSchemas.MAX_KEY_LENGTH - 5)}_copy`,
      );
      const { id: _id, createdAt: _createdAt, ...values } = task;
      const copy = one(
        await tx
          .insert(protocolTasks)
          .values({
            ...values,
            taskKey,
            internalName: task.internalName ? `${task.internalName} (copy)` : null,
          })
          .returning(),
      );
      const followups = await tx
        .select()
        .from(protocolTaskFollowups)
        .where(eq(protocolTaskFollowups.protocolTaskId, task.id));
      if (followups.length > 0) {
        await tx
          .insert(protocolTaskFollowups)
          .values(followups.map(({ id: _followupId, ...rest }) => ({ ...rest, protocolTaskId: copy.id })));
      }
      const ordered = sortTasks(all, protocol.orderConfigJson);
      const desired: Array<{ id: string; blockKey: string }> = [];
      for (const row of ordered) {
        desired.push({ id: row.id, blockKey: row.blockKey });
        if (row.id === task.id) desired.push({ id: copy.id, blockKey: copy.blockKey });
      }
      await writeTaskLayout(tx, protocol.orderConfigJson, [...all, copy], desired);
      await auditDraftChange(tx, ctx, protocol.id, null, {
        taskCloned: { fromTaskKey: task.taskKey, taskKey, followupCount: followups.length },
      });
      return protocol.id;
    })
    .catch(conflictOnKey);
  return loadProtocolDetail(ctx.db, protocolVersionId);
}

// Deletes a task of a draft with its follow-ups.
export async function deleteTask(
  ctx: ServiceContext,
  taskId: string,
  options: EditOptions = {},
): Promise<ProtocolDetail> {
  const protocolVersionId = await ctx.db.transaction(async (tx) => {
    const { protocol, task } = await loadTaskForEdit(tx, taskId, options);
    await tx.delete(protocolTasks).where(eq(protocolTasks.id, taskId));
    await renumberTasks(tx, protocol.id, protocol.orderConfigJson);
    await auditDraftChange(tx, ctx, protocol.id, { taskRemoved: taskSnapshot(task) }, null);
    return protocol.id;
  });
  return loadProtocolDetail(ctx.db, protocolVersionId);
}

// Moves a task one step up or down in the presentation order. Inside a block
// it swaps with its neighbor. At the edge of a block it moves into the
// neighboring block (to the end of the block above, or the start of the block
// below). At the very top or bottom nothing changes.
export async function moveTask(
  ctx: ServiceContext,
  taskId: string,
  direction: MoveDirection,
  options: EditOptions = {},
): Promise<ProtocolDetail> {
  const protocolVersionId = await ctx.db.transaction(async (tx) => {
    const { protocol, task } = await loadTaskForEdit(tx, taskId, options);
    const orderConfig = protocol.orderConfigJson;
    const all = await loadTaskRows(tx, protocol.id);
    const ordered = sortTasks(all, orderConfig).map((row) => ({ id: row.id, blockKey: row.blockKey }));
    const index = ordered.findIndex((row) => row.id === task.id);
    const current = ordered[index];
    if (!current) return protocol.id;
    const neighbor = ordered[direction === "up" ? index - 1 : index + 1];
    const blockKeys = orderConfig.blocks.map((block) => block.key);
    const blockIndex = blockKeys.indexOf(current.blockKey);

    if (neighbor && neighbor.blockKey === current.blockKey) {
      ordered[index] = neighbor;
      ordered[direction === "up" ? index - 1 : index + 1] = current;
    } else if (blockIndex !== -1) {
      // At the edge of its block: step into the neighboring block. The position
      // in the overall list stays the same, only the block changes.
      const targetBlock = blockKeys[direction === "up" ? blockIndex - 1 : blockIndex + 1];
      if (targetBlock === undefined) return protocol.id;
      current.blockKey = targetBlock;
    } else {
      return protocol.id;
    }

    await writeTaskLayout(tx, orderConfig, all, ordered);
    const newIndex = ordered.findIndex((row) => row.id === task.id);
    await auditDraftChange(
      tx,
      ctx,
      protocol.id,
      { taskMoved: { taskKey: task.taskKey, blockKey: task.blockKey, position: index + 1 } },
      { taskMoved: { taskKey: task.taskKey, blockKey: current.blockKey, position: newIndex + 1 } },
    );
    return protocol.id;
  });
  return loadProtocolDetail(ctx.db, protocolVersionId);
}

// ---------------------------------------------------------------------------
// Follow-ups (predefined texts only)
// ---------------------------------------------------------------------------

export async function addFollowup(
  ctx: ServiceContext,
  taskId: string,
  input: FollowupInput,
  options: EditOptions = {},
): Promise<ProtocolDetail> {
  const protocolVersionId = await ctx.db
    .transaction(async (tx) => {
      const { protocol, task } = await loadTaskForEdit(tx, taskId, options);
      const existing = await tx
        .select()
        .from(protocolTaskFollowups)
        .where(eq(protocolTaskFollowups.protocolTaskId, taskId));
      const existingKeys = existing.map((followup) => followup.followupKey);
      if (input.followupKey && existingKeys.includes(input.followupKey)) {
        throw new AppError("CONFLICT", `The follow-up key "${input.followupKey}" is already used in this task.`);
      }
      const followupKey = input.followupKey ?? uniqueKey(existingKeys, `followup_${existing.length + 1}`);
      const followup = one(
        await tx
          .insert(protocolTaskFollowups)
          .values({
            protocolTaskId: taskId,
            followupKey,
            promptText: input.promptText,
            orderIndex: existing.reduce((max, row) => Math.max(max, row.orderIndex), -1) + 1,
            isRequired: input.isRequired ?? true,
            enabled: input.enabled ?? true,
            translationsJson: compactTranslations(input.translations),
          })
          .returning(),
      );
      await renumberFollowups(tx, taskId);
      await auditDraftChange(tx, ctx, protocol.id, null, {
        taskKey: task.taskKey,
        followupAdded: {
          followupKey,
          promptText: followup.promptText,
          isRequired: followup.isRequired,
          enabled: followup.enabled,
        },
      });
      return protocol.id;
    })
    .catch(conflictOnKey);
  return loadProtocolDetail(ctx.db, protocolVersionId);
}

export async function updateFollowup(
  ctx: ServiceContext,
  followupId: string,
  changes: FollowupChanges,
  options: EditOptions & { taskId?: string } = {},
): Promise<ProtocolDetail> {
  const protocolVersionId = await ctx.db.transaction(async (tx) => {
    const { protocol, task, followup } = await loadFollowupForEdit(tx, followupId, options);
    const { translations, ...columns } = changes;
    const next: Partial<typeof followup> = { ...columns };
    if (translations !== undefined) next.translationsJson = compactTranslations(translations);
    const diff = changedFields(followup, next);
    if (diff.keys.length === 0) return protocol.id;
    await tx.update(protocolTaskFollowups).set(diff.after).where(eq(protocolTaskFollowups.id, followupId));
    await auditDraftChange(
      tx,
      ctx,
      protocol.id,
      { taskKey: task.taskKey, followupKey: followup.followupKey, followup: diff.before },
      { taskKey: task.taskKey, followupKey: followup.followupKey, followup: diff.after },
    );
    return protocol.id;
  });
  return loadProtocolDetail(ctx.db, protocolVersionId);
}

export async function deleteFollowup(
  ctx: ServiceContext,
  followupId: string,
  options: EditOptions & { taskId?: string } = {},
): Promise<ProtocolDetail> {
  const protocolVersionId = await ctx.db.transaction(async (tx) => {
    const { protocol, task, followup } = await loadFollowupForEdit(tx, followupId, options);
    await tx.delete(protocolTaskFollowups).where(eq(protocolTaskFollowups.id, followupId));
    await renumberFollowups(tx, task.id);
    await auditDraftChange(
      tx,
      ctx,
      protocol.id,
      {
        taskKey: task.taskKey,
        followupRemoved: { followupKey: followup.followupKey, promptText: followup.promptText },
      },
      null,
    );
    return protocol.id;
  });
  return loadProtocolDetail(ctx.db, protocolVersionId);
}

export async function moveFollowup(
  ctx: ServiceContext,
  followupId: string,
  direction: MoveDirection,
  options: EditOptions & { taskId?: string } = {},
): Promise<ProtocolDetail> {
  const protocolVersionId = await ctx.db.transaction(async (tx) => {
    const { protocol, task, followup } = await loadFollowupForEdit(tx, followupId, options);
    const ordered = await tx
      .select()
      .from(protocolTaskFollowups)
      .where(eq(protocolTaskFollowups.protocolTaskId, task.id))
      .orderBy(asc(protocolTaskFollowups.orderIndex), asc(protocolTaskFollowups.id));
    const index = ordered.findIndex((row) => row.id === followup.id);
    const target = direction === "up" ? index - 1 : index + 1;
    const current = ordered[index];
    const neighbor = ordered[target];
    if (!current || !neighbor) return protocol.id;
    ordered[index] = neighbor;
    ordered[target] = current;
    for (const [position, row] of ordered.entries()) {
      if (row.orderIndex !== position) {
        await tx
          .update(protocolTaskFollowups)
          .set({ orderIndex: position })
          .where(eq(protocolTaskFollowups.id, row.id));
      }
    }
    await auditDraftChange(
      tx,
      ctx,
      protocol.id,
      { taskKey: task.taskKey, followupMoved: { followupKey: followup.followupKey, position: index + 1 } },
      { taskKey: task.taskKey, followupMoved: { followupKey: followup.followupKey, position: target + 1 } },
    );
    return protocol.id;
  });
  return loadProtocolDetail(ctx.db, protocolVersionId);
}
