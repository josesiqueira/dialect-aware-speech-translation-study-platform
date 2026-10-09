// English defaults for every string the recorder components show or announce.
// Pages pass localized values through the `labels` prop (spec 100). Placeholders
// in braces are replaced by the component: {seconds}, {duration}, {percent}.
import type { RecorderMessageKey } from "@/lib/client/recorder";
import { DEFAULT_RECORDING_LABELS, type RecordingControlLabels } from "../RecordingControlFrame";

/** Plain-language text for each recorder message key. */
export type RecorderErrorLabels = Record<RecorderMessageKey, string>;

export const DEFAULT_RECORDER_ERROR_LABELS: RecorderErrorLabels = {
  "microphone.permission_denied":
    "This page is not allowed to use the microphone. To allow it, select the icon at the left end of the address bar, set Microphone to Allow, and then choose Try again.",
  "microphone.not_found":
    "No microphone was found. Connect a microphone or a headset, and then choose Try again.",
  "microphone.busy":
    "The microphone could not be opened. Another program may be using it. Close other programs that use the microphone, and then choose Try again.",
  "microphone.unsupported":
    "This browser cannot record audio on this page. Please open the study in a current version of Chrome.",
  "recording.device_disconnected":
    "The microphone was disconnected, so the recording stopped. Connect the microphone again, and then choose Try again.",
  "recording.interrupted":
    "The recording was interrupted by the browser. Nothing was saved from it. Choose Try again to record once more.",
  "recording.start_failed": "The recording could not be started. Choose Try again.",
  "recording.empty": "Nothing was recorded. Choose Try again, and speak after the recording has started.",
  "recording.already_active": "Another recording is still running. Stop it first, and then choose Try again.",
  "upload.failed": "The recording could not be uploaded. It is still here: you do not need to record again.",
};

export interface RecordingTaskLabels extends RecordingControlLabels {
  errors: RecorderErrorLabels;
  /** Shown before and during recording. {duration} is the limit as a clock, for example 02:00. */
  maxDurationNote: string;
  /** Shown after the recorder stopped at the limit. */
  maxDurationReached: string;
  /** Shown when the candidate is shorter than the task minimum. {seconds} is the minimum. */
  minDurationHint: string;
  /** Shown when the candidate has almost no signal. */
  silentHint: string;
  /** Button text while uploading with known progress. {percent} is 0 to 100. */
  uploadingProgress: string;
  /** Shown after the server confirmed the recording. */
  submitted: string;
}

export const DEFAULT_RECORDING_TASK_LABELS: RecordingTaskLabels = {
  ...DEFAULT_RECORDING_LABELS,
  errors: DEFAULT_RECORDER_ERROR_LABELS,
  maxDurationNote: "The recording stops by itself after {duration}.",
  maxDurationReached: "The recording reached the maximum length and was stopped.",
  minDurationHint: "This recording is very short. Please record again and speak for at least {seconds} seconds.",
  silentHint:
    "This recording seems to be silent. Listen to it. If you cannot hear yourself, check the microphone and record again.",
  uploadingProgress: "Uploading... {percent}%",
  submitted: "The recording was saved.",
};

export interface MicCheckLabels {
  errors: RecorderErrorLabels;
  intro: string;
  allow: string;
  requestingPermission: string;
  permissionHint: string;
  recordInstruction: string;
  recordTest: string;
  recording: string;
  stop: string;
  playbackLabel: string;
  listenInstruction: string;
  silentWarning: string;
  tryAgain: string;
  continue: string;
  privacyNote: string;
  announceRequestingPermission: string;
  announceReady: string;
  announceRecording: string;
  announceStopped: string;
  announceError: string;
}

export const DEFAULT_MIC_CHECK_LABELS: MicCheckLabels = {
  errors: DEFAULT_RECORDER_ERROR_LABELS,
  intro: "Before the study starts, check that your microphone works. Your browser will ask for permission to use it.",
  allow: "Allow microphone",
  requestingPermission: "Waiting for microphone...",
  permissionHint: "Your browser is asking for permission to use the microphone. Choose Allow to continue.",
  recordInstruction: "Record a short test: say a sentence in your normal voice. The test stops by itself after about {seconds} seconds.",
  recordTest: "Record test",
  recording: "Recording",
  stop: "Stop",
  playbackLabel: "Your test recording",
  listenInstruction: "Listen to the test. If you can hear yourself clearly, continue. If not, try again.",
  silentWarning:
    "The test seems to be silent. Check that the right microphone is connected and not muted, and then try again.",
  tryAgain: "Try again",
  continue: "Continue",
  privacyNote: "The test recording stays on this device. It is not saved or sent anywhere, and it is deleted when you continue.",
  announceRequestingPermission: "Waiting for microphone permission.",
  announceReady: "The microphone is ready. You can record a test.",
  announceRecording: "Recording started.",
  announceStopped: "Recording stopped. You can play the test, try again, or continue.",
  announceError: "The microphone could not be used.",
};

/** Replaces {name} placeholders in a label. */
export function fillLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
