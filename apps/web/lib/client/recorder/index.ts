// Browser audio capture for the participant study. Import from "@/lib/client/recorder".
// Documentation: docs/AUDIO-CAPTURE.md, section "Browser capture".
export type {
  ActualTrackSettings,
  ConstraintMismatch,
  CreatedRecorder,
  MicrophoneAccess,
  PcmBitDepth,
  Recorder,
  RecorderCallbacks,
  RecorderFallbackInfo,
  RecorderImplementation,
  RecorderOptions,
  RecorderProgress,
  RecorderState,
  RecordingResult,
  RequestedAudioConstraints,
  StoppedBy,
} from "./types";
export {
  RecorderError,
  RECORDER_MESSAGE_KEYS,
  isRecorderError,
  mapGetUserMediaError,
  toRecorderError,
  type RecorderErrorCode,
  type RecorderMessageKey,
} from "./errors";
export {
  PREFERRED_SAMPLE_RATE_HZ,
  buildAudioConstraints,
  contextRateMismatch,
  detectConstraintMismatches,
  type AudioConstraintOptions,
} from "./constraints";
export {
  describeMicrophone,
  releaseMicrophone,
  releaseStream,
  requestMicrophone,
  type RequestMicrophoneOptions,
} from "./microphone";
export { createRecorder, type CreateRecorderOptions } from "./createRecorder";
export {
  DEFAULT_PCM_BIT_DEPTH,
  PCM_WORKLET_PROCESSOR,
  PCM_WORKLET_URL,
  PcmRecorder,
  isAudioWorkletSupported,
  type PcmRecorderOptions,
} from "./PcmRecorder";
export {
  FALLBACK_MIME_TYPES,
  MediaRecorderFallback,
  isMediaRecorderSupported,
  selectFallbackMimeType,
} from "./MediaRecorderFallback";
export { isRecordingActive } from "./activeRecording";
export {
  PcmChunkCollector,
  WAV_HEADER_BYTES,
  WAV_MIME_TYPE,
  buildWavHeader,
  bytesPerSample,
  concatBytes,
  convertBlock,
  durationMsFromFrames,
  encodeWavMono,
  floatToPcmSample,
  maxFramesForDuration,
  type AppendResult,
  type ConvertedBlock,
  type PcmCollectorOptions,
} from "./wav";
