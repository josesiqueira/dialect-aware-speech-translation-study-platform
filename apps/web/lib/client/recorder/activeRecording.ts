// Only one recording may be active at a time in a page (spec 9). Both recorder
// implementations claim this lock in start() and give it back when they end.
import { RecorderError } from "./errors";

let activeOwner: object | null = null;

export function claimRecording(owner: object): void {
  if (activeOwner !== null && activeOwner !== owner) {
    throw new RecorderError("RECORDING_FAILED", "recording.already_active", "Another recording is already active.");
  }
  activeOwner = owner;
}

export function releaseRecording(owner: object): void {
  if (activeOwner === owner) activeOwner = null;
}

export function isRecordingActive(): boolean {
  return activeOwner !== null;
}
