// Bookkeeping for the task turn that is shown (docs/PARTICIPANT-API.md, section 6).
// It is plain data outside React: nothing here is rendered.
import type { sessionSchemas } from "@dialect/domain";
import type { RecorderFallbackInfo } from "@/lib/client/recorder";
import { participantApi } from "./participantApi";

type CurrentTask = sessionSchemas.CurrentTask;

type TurnEntry = {
  key: string;
  /** Resolves with the utterance id once the task is started and the utterance row exists. */
  prepare: Promise<string> | null;
  /** The upload that is stored on the server as the candidate of this turn. */
  uploaded: { attempt: number; mediaAssetId: string } | null;
  fallback: RecorderFallbackInfo | null;
  abort: AbortController | null;
};

/** One key per task and turn. Also the React key of the task step. */
export const turnKeyOf = (task: CurrentTask) => `${task.presentationId}:${task.turn.turnIndex}`;

/** Starts the task, creates the utterance of the turn and removes a candidate left by a page reload. */
async function prepareTurn(task: CurrentTask): Promise<string> {
  if (task.status === "pending") await participantApi.startTask(task.presentationId);
  let utteranceId = task.turn.utteranceId;
  if (!utteranceId) {
    const created = await participantApi.createUtterance({
      presentationId: task.presentationId,
      turnIndex: task.turn.turnIndex,
    });
    utteranceId = created.utteranceId;
  }
  // After a reload the browser no longer holds the recording of an uploaded
  // candidate, so it cannot be listened to or submitted knowingly: remove it.
  if (task.turn.candidate) await participantApi.deleteCandidate(utteranceId);
  return utteranceId;
}

export interface TurnTracker {
  /**
   * The utterance id of the turn. The first call for a turn starts the task
   * and creates the utterance. Later calls return the same promise. A failed
   * preparation is tried again by the next call.
   */
  ensure(task: CurrentTask): Promise<string>;
  /** The media asset id of the upload of this attempt, when it already arrived. */
  uploadedAttempt(task: CurrentTask, attempt: number): string | null;
  setUploaded(task: CurrentTask, attempt: number, mediaAssetId: string): void;
  /** Forgets the upload without telling the server (after a submit, or when the server no longer has it). */
  clearUploaded(): void;
  /**
   * The participant recorded again or discarded the recording. An upload of
   * another attempt is removed from the server (spec 10). `attempt` is the
   * attempt number of the recording that is now in the browser, or null.
   */
  candidateChanged(attempt: number | null): void;
  setFallback(fallback: RecorderFallbackInfo): void;
  fallback(): RecorderFallbackInfo | null;
  /** A signal for the next upload. `abort` cancels it. */
  newAbortSignal(): AbortSignal;
  abort(): void;
  /** Cancels a running upload and forgets the turn. */
  reset(): void;
}

export function createTurnTracker(): TurnTracker {
  let entry: TurnEntry | null = null;

  const entryFor = (task: CurrentTask): TurnEntry => {
    const key = turnKeyOf(task);
    if (!entry || entry.key !== key) {
      entry?.abort?.abort();
      entry = { key, prepare: null, uploaded: null, fallback: null, abort: null };
    }
    return entry;
  };

  return {
    ensure(task) {
      const current = entryFor(task);
      if (!current.prepare) {
        const pending = prepareTurn(task);
        current.prepare = pending;
        pending.catch(() => {
          if (current.prepare === pending) current.prepare = null;
        });
      }
      return current.prepare;
    },
    uploadedAttempt(task, attempt) {
      const current = entryFor(task);
      return current.uploaded && current.uploaded.attempt === attempt ? current.uploaded.mediaAssetId : null;
    },
    setUploaded(task, attempt, mediaAssetId) {
      entryFor(task).uploaded = { attempt, mediaAssetId };
    },
    clearUploaded() {
      if (entry) entry.uploaded = null;
    },
    candidateChanged(attempt) {
      if (!entry?.uploaded || !entry.prepare) return;
      if (attempt !== null && attempt === entry.uploaded.attempt) return;
      entry.uploaded = null;
      entry.prepare.then((utteranceId) => participantApi.deleteCandidate(utteranceId)).catch(() => undefined);
    },
    setFallback(fallback) {
      if (entry) entry.fallback = fallback;
    },
    fallback() {
      return entry?.fallback ?? null;
    },
    newAbortSignal() {
      const controller = new AbortController();
      if (entry) entry.abort = controller;
      return controller.signal;
    },
    abort() {
      entry?.abort?.abort();
    },
    reset() {
      entry?.abort?.abort();
      entry = null;
    },
  };
}
