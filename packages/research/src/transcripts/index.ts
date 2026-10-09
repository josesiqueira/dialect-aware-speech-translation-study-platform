// Human transcription and review (spec 16 to 19, 46).
// Usage: import { transcripts } from "@dialect/research"; transcripts.saveTranscriptRevision(ctx, ...)
export {
  saveTranscriptRevision,
  saveRevisionForTranscript,
  verifyTranscript,
  setTranscriptStatus,
  getTranscriptHistory,
  type SaveTranscriptRevisionInput,
  type SaveRevisionForTranscriptInput,
  type VerifyTranscriptInput,
  type SetTranscriptStatusInput,
} from "./revisions";
export { saveDifferenceAnnotation, type SaveDifferenceAnnotationInput } from "./annotations";
export {
  addFlag,
  resolveFlag,
  addNote,
  type AddFlagInput,
  type ResolveFlagInput,
  type AddNoteInput,
} from "./flags";
export { getUtteranceForReview } from "./review";
export {
  listReviewQueue,
  queueArgumentsFromQuery,
  type ReviewQueueFilters,
  type ReviewQueuePagination,
} from "./queue";
