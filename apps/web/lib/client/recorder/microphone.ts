// Opening and releasing the microphone (spec 6.3, 31.1, 138).
//
// Call requestMicrophone only when the participant has reached the microphone
// step and pressed a button. It is never called on page load.
import { sessionSchemas } from "@dialect/domain";
import { buildAudioConstraints, detectConstraintMismatches } from "./constraints";
import { mapGetUserMediaError, RecorderError } from "./errors";
import type { ActualTrackSettings, MicrophoneAccess, RequestedAudioConstraints } from "./types";

export interface RequestMicrophoneOptions {
  /** Prefer one specific input device (a deviceId from enumerateDevices). */
  deviceId?: string;
  /** For tests: replaces navigator.mediaDevices. */
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> & Partial<Pick<MediaDevices, "getSupportedConstraints">>;
}

/** Copies a browser dictionary to a plain JSON object (drops functions and undefined values). */
function toPlainObject(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Reads the facts about an open stream: what the track really delivers, the
 * class of the input device, the capabilities, and every requested setting that
 * was not confirmed. Use this for a stream that was opened elsewhere.
 *
 * Privacy: nothing that identifies the participant's device leaves this
 * function. `deviceId` and `groupId` are removed from the track settings, the
 * requested constraints and the capabilities. The device label (which can
 * contain a person's name, for example "Anna's AirPods") is reduced to a coarse
 * class by a keyword rule (`classifyInputDevice` in @dialect/domain: built_in,
 * usb, bluetooth, headset, unknown) and the label itself is dropped. The server
 * applies the same rule again.
 */
export function describeMicrophone(stream: MediaStream, requestedConstraints: RequestedAudioConstraints): MicrophoneAccess {
  const track = stream.getAudioTracks()[0];
  if (!track) {
    throw new RecorderError("RECORDING_FAILED", "microphone.not_found", "The stream has no audio track.");
  }
  const actualTrackSettings: ActualTrackSettings = sessionSchemas.stripDeviceIdentifiers(
    toPlainObject(track.getSettings()),
  );
  const capabilities =
    typeof track.getCapabilities === "function"
      ? sessionSchemas.stripDeviceIdentifiers(toPlainObject(track.getCapabilities()))
      : null;
  const reportedConstraints = sessionSchemas.stripDeviceIdentifiers(requestedConstraints);
  return {
    stream,
    track,
    requestedConstraints: reportedConstraints,
    actualTrackSettings,
    // The class, never the label. Null when the browser gives no label.
    deviceLabel: track.label ? sessionSchemas.classifyInputDevice(track.label) : null,
    capabilities,
    constraintMismatches: detectConstraintMismatches(reportedConstraints, actualTrackSettings),
  };
}

/**
 * Asks for the microphone with the constraints of spec 31.1 and reports what
 * the browser actually returned. The requested constraints are preferences, so
 * a device that cannot honor them still opens: the differences are listed in
 * `constraintMismatches` for the page to store. Throws RecorderError with code
 * MICROPHONE_PERMISSION_DENIED or RECORDING_FAILED.
 */
export async function requestMicrophone(options: RequestMicrophoneOptions = {}): Promise<MicrophoneAccess> {
  const mediaDevices = options.mediaDevices ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
    // navigator.mediaDevices is undefined on pages that are not served over HTTPS (or localhost).
    throw new RecorderError(
      "RECORDING_FAILED",
      "microphone.unsupported",
      "navigator.mediaDevices.getUserMedia is not available (old browser, or the page is not in a secure context).",
    );
  }
  const supportedConstraints =
    typeof mediaDevices.getSupportedConstraints === "function"
      ? (mediaDevices.getSupportedConstraints() as Record<string, boolean | undefined>)
      : undefined;
  const requestedConstraints = buildAudioConstraints({ supportedConstraints, deviceId: options.deviceId });

  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia({ audio: requestedConstraints as MediaTrackConstraints, video: false });
  } catch (error) {
    throw mapGetUserMediaError(error);
  }
  try {
    // getSettings() is read after the promise resolved, which is when the track is live.
    return describeMicrophone(stream, requestedConstraints);
  } catch (error) {
    releaseStream(stream);
    throw error;
  }
}

/** Stops every track of a stream, which switches the browser's microphone indicator off. */
export function releaseStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track that is already stopped needs nothing.
    }
  }
}

/** Releases the microphone of a MicrophoneAccess (spec 138: reset media device state). */
export function releaseMicrophone(microphone: MicrophoneAccess | null | undefined): void {
  releaseStream(microphone?.stream);
}
