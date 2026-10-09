// Demo Mode, the admin pipeline test and the mock provider configurations
// (spec 3.2, 52, 80, 81, 162, 163). Used as `demo.*` from @dialect/research.
// Described in docs/DEMO-MODE.md.
export {
  startDemoSession,
  getDemoAccess,
  getDemoSessionInfo,
  findDemoSessionByToken,
  completeDemoSession,
  demoAcknowledgementOf,
  demoSettings,
  DEFAULT_DEMO_DAILY_RUN_LIMIT,
  type DemoAcknowledgement,
  type DemoSettings,
  type StartDemoSessionInput,
  type StartedDemoSession,
} from "./session";
export { createDemoUtterance, type DemoRecordingInput, type StoredRecording } from "./recording";
export { runDemoPipeline, type RunDemoPipelineInput } from "./run";
export {
  consumeDemoRunBudget,
  demoBudgetBucket,
  DEMO_BUDGET_WINDOW_SECONDS,
  MAX_STEP_ATTEMPTS,
} from "./budget";
export {
  resolvePipelineConfigs,
  type PipelineConfigSelection,
  type PipelineStageSelection,
  type ResolvedPipelineConfigs,
} from "./pipeline";
export {
  purgeDemoSession,
  purgeLeftoverDemoSessions,
  listLeftoverDemoSessions,
  getDemoMediaForStreaming,
  LEFTOVER_IDLE_MINUTES,
  type DemoMediaAsset,
} from "./purge";
export {
  runPipelineTest,
  getLastPipelineTest,
  generateTestTone,
  type PipelineTestAudio,
  type RunPipelineTestInput,
} from "./pipeline-test";
export {
  ensureMockPipelineConfigs,
  mockProviderAvailable,
  MOCK_CONFIG_KEYS,
  type MockPipelineConfigs,
} from "./mock-configs";
