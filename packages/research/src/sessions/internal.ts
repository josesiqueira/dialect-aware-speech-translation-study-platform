// Helpers shared by the session services. Not exported from the package index.
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  mediaAssets,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireResponses,
  sessions,
  studies,
  taskPresentations,
  utterances,
  type DbOrTx,
} from "@dialect/db";
import { AppError, localizeText, TERMINAL_SESSION_STATUSES, type SessionStatus } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { enqueueJob } from "../jobs/queue";
import {
  effectiveSettings,
  MAINTENANCE_MESSAGE,
  type EffectiveSettings,
  type StudyRow,
} from "./settings";

export type SessionRow = typeof sessions.$inferSelect;
export type ProtocolRow = typeof protocolVersions.$inferSelect;
export type TaskRow = typeof protocolTasks.$inferSelect;
export type PresentationRow = typeof taskPresentations.$inferSelect;
export type UtteranceRow = typeof utterances.$inferSelect;
export type MediaRow = typeof mediaAssets.$inferSelect;

// The session argument of every service: a row from getSessionByToken, or just its id.
export type SessionRef = Pick<SessionRow, "id">;

// Kinds a participant upload can have.
export const UPLOAD_KINDS = ["source_audio", "source_audio_raw"] as const;
// An utterance that the participant can still change.
export const OPEN_UTTERANCE_STATUSES = ["recording", "uploading"] as const;

export function isTerminalStatus(status: SessionStatus): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);
}

export function invalidState(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("INVALID_STATE", message, details);
}

export type LockedSession = { session: SessionRow; study: StudyRow; settings: EffectiveSettings };

// Locks the session row for the rest of the transaction. Two requests for the
// same session (two tabs, a double click) therefore run one after the other.
export async function lockSession(tx: DbOrTx, sessionId: string): Promise<LockedSession> {
  const [session] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
  if (!session) throw new AppError("SESSION_EXPIRED", "Your session was not found. Please start again.");
  const [study] = await tx.select().from(studies).where(eq(studies.id, session.studyId));
  if (!study) throw new AppError("CONFIGURATION_MISSING", "The study of this session no longer exists.");
  return { session, study, settings: effectiveSettings(study.settingsJson) };
}

// Terminal sessions accept no further writes.
export function assertActive(session: SessionRow): void {
  if (isTerminalStatus(session.status)) {
    throw invalidState("This session has ended and can no longer be changed.", { status: session.status });
  }
}

// Maintenance mode stops running sessions too (spec 87).
export function assertNotInMaintenance(settings: EffectiveSettings): void {
  if (settings.maintenanceMode) {
    throw new AppError("STUDY_CLOSED", settings.maintenanceMessage ?? MAINTENANCE_MESSAGE, {
      reason: "maintenance",
    });
  }
}

export async function lockActiveSession(tx: DbOrTx, sessionId: string): Promise<LockedSession> {
  const locked = await lockSession(tx, sessionId);
  assertActive(locked.session);
  assertNotInMaintenance(locked.settings);
  return locked;
}

export function assertStatus(session: SessionRow, expected: SessionStatus, action: string): void {
  if (session.status !== expected) {
    throw invalidState(`${action} is not possible at this point of the study.`, {
      status: session.status,
      expected,
    });
  }
}

export async function loadProtocol(db: DbOrTx, protocolVersionId: string): Promise<ProtocolRow> {
  const [protocol] = await db.select().from(protocolVersions).where(eq(protocolVersions.id, protocolVersionId));
  if (!protocol) throw new AppError("CONFIGURATION_MISSING", "The protocol of this session no longer exists.");
  return protocol;
}

// ---------------------------------------------------------------------------
// Presentations and turns
// ---------------------------------------------------------------------------

export type Turn = {
  turnIndex: number;
  promptText: string;
  followupId: string | null;
  isFollowup: boolean;
  isOptional: boolean;
};

// The presentation the participant is working on: the first one in the stored
// sequence that is not completed. Null when all are done.
export async function currentPresentation(db: DbOrTx, sessionId: string): Promise<PresentationRow | null> {
  const [row] = await db
    .select()
    .from(taskPresentations)
    .where(and(eq(taskPresentations.sessionId, sessionId), inArray(taskPresentations.status, ["pending", "started"])))
    .orderBy(asc(taskPresentations.sequenceIndex))
    .limit(1);
  return row ?? null;
}

// Turn 0 is the main prompt (the text stored in the presentation). Turns 1..n are
// the enabled follow-ups of the task in order. The protocol is published and
// cannot change, so reading its follow-ups later gives the same list.
// A text of a task as the participant sees it. While the session is in the
// locale the snapshot was taken in, the stored snapshot (spec 8, 77). After the
// participant switched the language, the text of the published task in the new
// locale. Each recording keeps the prompt that was shown (utterances.prompt_snapshot).
export function shownTaskText<T extends string | null>(
  snapshot: T,
  presentation: Pick<PresentationRow, "snapshotLocale">,
  task: TaskRow,
  locale: string | null,
  field: "title" | "participantPrompt" | "contextText" | "instructionsText",
): T | string {
  if (presentation.snapshotLocale === null || presentation.snapshotLocale === locale) return snapshot;
  // The base column has the same nullability as the snapshot column.
  return localizeText(task[field], task.translationsJson, locale, field) as T | string;
}

// Turns are shown in the locale of the session (pass session.locale).
export async function loadTurns(
  db: DbOrTx,
  presentation: PresentationRow,
  locale: string | null,
): Promise<{ task: TaskRow; turns: Turn[] }> {
  const [task] = await db.select().from(protocolTasks).where(eq(protocolTasks.id, presentation.protocolTaskId));
  if (!task) throw new AppError("CONFIGURATION_MISSING", "The task of this presentation no longer exists.");
  const followups = await db
    .select()
    .from(protocolTaskFollowups)
    .where(and(eq(protocolTaskFollowups.protocolTaskId, task.id), eq(protocolTaskFollowups.enabled, true)))
    .orderBy(asc(protocolTaskFollowups.orderIndex), asc(protocolTaskFollowups.followupKey));
  const allOptional = task.configJson?.followupMode === "optional";
  const turns: Turn[] = [
    {
      turnIndex: 0,
      promptText: shownTaskText(presentation.promptSnapshot, presentation, task, locale, "participantPrompt"),
      followupId: null,
      isFollowup: false,
      isOptional: false,
    },
    ...followups.map((followup, index) => ({
      turnIndex: index + 1,
      promptText: localizeText(followup.promptText, followup.translationsJson, locale, "promptText"),
      followupId: followup.id,
      isFollowup: true,
      isOptional: allOptional || !followup.isRequired,
    })),
  ];
  return { task, turns };
}

export async function loadUtterances(db: DbOrTx, presentationId: string): Promise<UtteranceRow[]> {
  return db
    .select()
    .from(utterances)
    .where(eq(utterances.taskPresentationId, presentationId))
    .orderBy(asc(utterances.turnIndex));
}

function isOpen(utterance: UtteranceRow): boolean {
  return (OPEN_UTTERANCE_STATUSES as readonly string[]).includes(utterance.status);
}

// The turn the participant must answer now, or null when the presentation is done.
// - An utterance that is not submitted yet marks the current turn (the one with
//   the highest index: a skipped turn leaves no row, and the row of the next turn
//   is created at once, so the skip is visible as a gap in the turn indexes).
// - Otherwise the current turn follows the last submitted one.
export function currentTurnIndex(turns: Turn[], rows: UtteranceRow[]): number | null {
  const open = rows.filter(isOpen);
  if (open.length > 0) return Math.max(...open.map((row) => row.turnIndex));
  const next = rows.reduce((max, row) => Math.max(max, row.turnIndex), -1) + 1;
  return next < turns.length ? next : null;
}

// The session status that follows the speech tasks: the background questionnaire
// when the protocol has one. Otherwise "post_questionnaire", which covers the
// post-recording questionnaire (when the protocol has one) and the debrief.
export function statusAfterTasks(protocol: ProtocolRow): SessionStatus {
  return protocol.backgroundQuestionnaireVersionId ? "background_questionnaire" : "post_questionnaire";
}

// Marks the presentation completed when no turn remains, and moves the session
// on when it was the last presentation. Call it inside the transaction that
// submitted or skipped a turn.
export async function advanceAfterTurn(
  tx: DbOrTx,
  session: SessionRow,
  presentation: PresentationRow,
  now: Date,
): Promise<void> {
  const { turns } = await loadTurns(tx, presentation, session.locale);
  const rows = await loadUtterances(tx, presentation.id);
  if (currentTurnIndex(turns, rows) !== null) return;
  await completePresentation(tx, session, presentation, now);
}

// Marks the presentation completed and, when it was the last one, moves the
// session to the step that follows the tasks.
export async function completePresentation(
  tx: DbOrTx,
  session: SessionRow,
  presentation: PresentationRow,
  now: Date,
): Promise<void> {
  await tx
    .update(taskPresentations)
    .set({ status: "completed", completedAt: now })
    .where(eq(taskPresentations.id, presentation.id));
  if (await currentPresentation(tx, session.id)) return;
  const protocol = await loadProtocol(tx, session.protocolVersionId);
  await tx
    .update(sessions)
    .set({ status: statusAfterTasks(protocol), lastActivityAt: now })
    .where(eq(sessions.id, session.id));
}

export async function hasQuestionnaireResponse(
  db: DbOrTx,
  sessionId: string,
  questionnaireVersionId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: questionnaireResponses.id })
    .from(questionnaireResponses)
    .where(
      and(
        eq(questionnaireResponses.sessionId, sessionId),
        eq(questionnaireResponses.questionnaireVersionId, questionnaireVersionId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Candidate recordings (uploaded, not submitted)
// ---------------------------------------------------------------------------

// Deletes the media rows of uploaded recordings that were never submitted, for one
// utterance or for a whole session, and sets those utterances back to "recording".
// Returns the storage keys: the caller removes the objects after the commit.
// The row goes first, so a failure never leaves a row that points at a missing file.
export async function removeCandidateRows(
  tx: DbOrTx,
  scope: { sessionId: string; utteranceId?: string },
): Promise<string[]> {
  const candidates = await tx
    .select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey, utteranceId: utterances.id })
    .from(mediaAssets)
    .innerJoin(utterances, eq(mediaAssets.utteranceId, utterances.id))
    .where(
      and(
        eq(utterances.sessionId, scope.sessionId),
        scope.utteranceId ? eq(utterances.id, scope.utteranceId) : undefined,
        inArray(utterances.status, [...OPEN_UTTERANCE_STATUSES]),
        inArray(mediaAssets.kind, [...UPLOAD_KINDS]),
      ),
    );
  if (candidates.length === 0) return [];
  await tx.delete(mediaAssets).where(
    inArray(
      mediaAssets.id,
      candidates.map((row) => row.id),
    ),
  );
  await tx
    .update(utterances)
    .set({ status: "recording" })
    .where(
      and(
        inArray(utterances.id, [...new Set(candidates.map((row) => row.utteranceId))]),
        eq(utterances.status, "uploading"),
      ),
    );
  return candidates.map((row) => row.storageKey);
}

// Job type and settings of the clean-up of a stored object that could not be
// deleted when its row was removed (spec 10: the audio of a rejected or replaced
// attempt is not kept). The handler is in ./storage-cleanup.ts.
export const DELETE_STORAGE_OBJECT_JOB = "delete_storage_object";
export const DELETE_STORAGE_OBJECT_MAX_ATTEMPTS = 8;

export function deleteStorageObjectJobKey(storageKey: string): string {
  return `${DELETE_STORAGE_OBJECT_JOB}:${storageKey}`;
}

// Removes stored objects whose rows are already gone. A failure does not fail the
// request: the object is then a file without a database row, which no part of
// the system treats as study data. So that the audio is still removed, the key
// is written to the job queue (type delete_storage_object) and the worker tries
// again with backoff. The storage key holds ids only, no personal data.
export async function deleteStoredObjects(ctx: ServiceContext, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await ctx.storage.delete(key);
    } catch (error) {
      ctx.logger.warn(
        { storageKey: key, error: error instanceof Error ? error.message : String(error) },
        "removing a discarded recording from storage failed, a clean-up job is queued",
      );
      try {
        await enqueueJob(ctx.db, {
          type: DELETE_STORAGE_OBJECT_JOB,
          payload: { type: DELETE_STORAGE_OBJECT_JOB, storageKey: key, reason: "delete_failed" },
          idempotencyKey: deleteStorageObjectJobKey(key),
          maxAttempts: DELETE_STORAGE_OBJECT_MAX_ATTEMPTS,
          availableAt: ctx.now(),
        });
      } catch (enqueueError) {
        // Nothing durable knows about the object now: this line is the only trace.
        ctx.logger.error(
          {
            storageKey: key,
            error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
          },
          "the clean-up job for a discarded recording could not be queued, the stored object must be removed by hand",
        );
      }
    }
  }
}
