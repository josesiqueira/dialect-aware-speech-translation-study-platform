// The microphone request of spec 31.1 and the comparison of what was asked for
// with what the browser reports. Pure functions: no browser API is called here.
import type { ActualTrackSettings, ConstraintMismatch, RequestedAudioConstraints } from "./types";

export const PREFERRED_SAMPLE_RATE_HZ = 48000;

export interface AudioConstraintOptions {
  /** Result of navigator.mediaDevices.getSupportedConstraints(). */
  supportedConstraints?: Record<string, boolean | undefined>;
  /** Ask for one specific input device. Used as a preference, not a hard requirement. */
  deviceId?: string;
}

/**
 * The audio constraints of spec 31.1: mono and no browser processing. A bare
 * value in getUserMedia is a preference ("ideal"), so an unsupported value never
 * makes the request fail. The sample rate preference is added only where the
 * browser lists `sampleRate` as a supported constraint.
 */
export function buildAudioConstraints(options: AudioConstraintOptions = {}): RequestedAudioConstraints {
  const constraints: RequestedAudioConstraints = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (options.supportedConstraints?.sampleRate) {
    constraints.sampleRate = { ideal: PREFERRED_SAMPLE_RATE_HZ };
  }
  if (options.deviceId) {
    constraints.deviceId = { ideal: options.deviceId };
  }
  return constraints;
}

/** The plain value a constraint asks for: 1 for `1`, 48000 for `{ ideal: 48000 }`. */
function requestedValue(constraint: unknown): unknown {
  if (typeof constraint === "object" && constraint !== null) {
    const record = constraint as Record<string, unknown>;
    if ("exact" in record) return record.exact;
    if ("ideal" in record) return record.ideal;
    return undefined;
  }
  return constraint;
}

const COMPARED_CONSTRAINTS = ["channelCount", "echoCancellation", "noiseSuppression", "autoGainControl", "sampleRate"] as const;

/**
 * Lists every requested capture setting that the track does not confirm.
 * A mismatch is information for researchers, never a reason to stop the
 * participant (spec 31.1: do not assume the requested constraints were honored).
 */
export function detectConstraintMismatches(
  requested: RequestedAudioConstraints,
  actual: ActualTrackSettings,
): ConstraintMismatch[] {
  const mismatches: ConstraintMismatch[] = [];
  for (const constraint of COMPARED_CONSTRAINTS) {
    if (!(constraint in requested)) continue;
    const wanted = requestedValue(requested[constraint]);
    if (wanted === undefined) continue;
    const got = actual[constraint];
    if (got === undefined || got === null) {
      mismatches.push({ constraint, kind: "not_reported", requested: wanted, actual: null });
    } else if (got !== wanted) {
      mismatches.push({ constraint, kind: "not_honored", requested: wanted, actual: got });
    }
  }
  return mismatches;
}

/** The mismatch recorded when the AudioContext did not run at the track's rate. */
export function contextRateMismatch(trackSampleRate: unknown, contextSampleRate: number): ConstraintMismatch | null {
  if (typeof trackSampleRate !== "number" || trackSampleRate === contextSampleRate) return null;
  return {
    constraint: "sampleRate",
    kind: "context_rate_differs",
    requested: trackSampleRate,
    actual: contextSampleRate,
  };
}
