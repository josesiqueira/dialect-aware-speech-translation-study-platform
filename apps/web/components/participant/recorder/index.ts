/** Stateful recorder components for the participant flow. Import from "@/components/participant/recorder". */
export {
  useRecorder,
  type MicrophoneInfo,
  type RecorderDependencies,
  type SubmitContext,
  type SubmitFunction,
  type UseRecorderOptions,
  type UseRecorderResult,
} from "./useRecorder";
export { RecordingTask, type RecordingTaskProps } from "./RecordingTask";
export { MicCheck, DEFAULT_MIC_TEST_DURATION_MS, type MicCheckProps, type MicCheckResult } from "./MicCheck";
export { LevelMeter, levelToFraction, type LevelMeterProps } from "./LevelMeter";
export {
  DEFAULT_MIC_CHECK_LABELS,
  DEFAULT_RECORDER_ERROR_LABELS,
  DEFAULT_RECORDING_TASK_LABELS,
  fillLabel,
  type MicCheckLabels,
  type RecorderErrorLabels,
  type RecordingTaskLabels,
} from "./labels";
export {
  INITIAL_RECORDER_STATE,
  SILENT_PEAK_THRESHOLD,
  isBelowMinimumDuration,
  recorderReducer,
  seemsSilent,
  type CaptureInfo,
  type RecorderErrorInfo,
  type RecorderEvent,
  type RecorderMachineState,
  type RecorderStatus,
  type RecordingCandidate,
} from "./recorderMachine";
