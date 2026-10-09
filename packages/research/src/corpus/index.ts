// Corpus inspection for the admin: Dashboard, Sessions, Session Detail, media,
// flags, exclusion, notes, audit history and Settings (spec 42 to 45, 59, 70, 71).
// Usage: import { corpus } from "@dialect/research"; corpus.getDashboard(ctx, studyId)
export { getDashboard } from "./dashboard";
export { listSessions, type ListSessionsFilters, type ListSessionsPagination } from "./sessions-list";
export { getSessionDetail } from "./session-detail";
export {
  setSessionFlag,
  setUtteranceFlag,
  excludeSession,
  includeSession,
  excludeUtterance,
  includeUtterance,
  addNote,
  setOutputStatus,
  type SetSessionFlagInput,
  type SetUtteranceFlagInput,
  type ExcludeSessionInput,
  type IncludeSessionInput,
  type ExcludeUtteranceInput,
  type IncludeUtteranceInput,
  type AddNoteInput,
  type SetOutputStatusInput,
  type FlagState,
  type SessionExclusionState,
  type UtteranceExclusionState,
  type OutputStatusState,
} from "./curation";
export { getAuditHistory, getSessionAuditHistory, type AuditHistoryInput } from "./audit-history";
export {
  getMediaForStreaming,
  getMediaDownloadName,
  recordMediaDownload,
  deleteMedia,
  type DeleteMediaInput,
  type MediaAssetRow,
} from "./media";
export {
  getSettings,
  updateSettings,
  testProviderConnectivity,
  resetTestData,
  getMigrationStatus,
  type SettingsRuntime,
  type ProviderClient,
  type ResetTestDataInput,
} from "./settings";
export { resolveStudy } from "./shared";
