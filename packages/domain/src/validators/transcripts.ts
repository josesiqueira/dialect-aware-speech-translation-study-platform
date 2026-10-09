// Request schemas and response types for human transcription and review
// (spec 16 to 19, 46, 60, 71, 88). Shared by the browser and the server.
//
// The four transcript representations of one utterance:
//   A  = asr            model output, immutable, never written through these schemas
//   A* = asr_corrected  a human corrects recognition errors only
//   B  = human_dialect  a human transcribes the audio and keeps dialect forms
//   C  = normalized     a human writes minimally normalized Finnish from B
import { z } from "zod";
import {
  ANNOTATION_SCOPES,
  DIFFERENCE_CATEGORIES,
  FLAG_REASON_CODES,
  STUDY_MODES,
  TASK_TYPES,
  type AnnotationScope,
  type DifferenceCategory,
  type FlagReasonCode,
  type ReviewStatus,
  type RevisionAuthorType,
  type SessionStatus,
  type StudyMode,
  type TaskType,
  type TranscriptType,
  type UtteranceStatus,
} from "../enums";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The transcript types a researcher may write. ASR revisions are created only by
// the processing pipeline.
export const HUMAN_TRANSCRIPT_TYPES = ["asr_corrected", "human_dialect", "normalized"] as const;
export type HumanTranscriptType = (typeof HUMAN_TRANSCRIPT_TYPES)[number];

// Which transcript type a text may be copied from as a starting point, recorded
// in transcript_revisions.derived_from_revision_id. B is transcribed from the
// audio, so it has no allowed source (spec 16).
export const DERIVATION_SOURCE_TYPE: Record<HumanTranscriptType, TranscriptType | null> = {
  asr_corrected: "asr",
  human_dialect: null,
  normalized: "human_dialect",
};

export const MAX_TRANSCRIPT_TEXT_LENGTH = 20000;
export const MAX_REASON_LENGTH = 1000;
export const MAX_NOTE_LENGTH = 5000;
export const MAX_LABEL_LENGTH = 100;

export const REVIEW_QUEUE_DEFAULT_PAGE_SIZE = 50;
export const REVIEW_QUEUE_MAX_PAGE_SIZE = 200;

// Queue conditions (spec 46). Several conditions are combined with AND.
//   unreviewed      none of A*, B, C has a revision yet
//   b_missing       B has no revision
//   c_missing       C has no revision
//   a_star_missing  A* has no revision
//   needs_review    at least one transcript has the status needs_review (second review)
//   flagged         the utterance is flagged, or it or one of its transcripts has an open flag
export const REVIEW_QUEUE_CONDITIONS = [
  "unreviewed",
  "b_missing",
  "c_missing",
  "a_star_missing",
  "needs_review",
  "flagged",
] as const;
export type ReviewQueueCondition = (typeof REVIEW_QUEUE_CONDITIONS)[number];

// The background questionnaire item whose answer the region filter searches,
// unless the request names another item key.
export const DEFAULT_REGION_ITEM_KEY = "region_grew_up";

// Entities of the review screen that can carry a flag or a note.
export const REVIEW_ENTITY_TYPES = ["utterance", "transcript"] as const;
export type ReviewEntityType = (typeof REVIEW_ENTITY_TYPES)[number];

// Statuses a researcher can set without saving text.
export const SETTABLE_TRANSCRIPT_STATUSES = ["needs_review", "draft"] as const;
export type SettableTranscriptStatus = (typeof SETTABLE_TRANSCRIPT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const id = z.uuid();
const label = z.string().trim().min(1).max(MAX_LABEL_LENGTH);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? undefined : value))
    .optional();

export const idParamSchema = z.object({ id });
export const utteranceTranscriptParamsSchema = z.object({
  id,
  type: z.enum(HUMAN_TRANSCRIPT_TYPES),
});

// ---------------------------------------------------------------------------
// Transcript revisions
// ---------------------------------------------------------------------------

// Body of POST /api/admin/transcripts/:id/revisions and
// POST /api/admin/utterances/:id/transcripts/:type/revisions.
export const saveRevisionBodySchema = z.object({
  // Stored exactly as entered. Only a text without any visible character is rejected.
  text: z
    .string()
    .max(MAX_TRANSCRIPT_TEXT_LENGTH)
    .refine((value) => value.trim().length > 0, { message: "The transcript text is empty." }),
  // Required by the service when the transcript is verified.
  changeReason: optionalText(MAX_REASON_LENGTH),
  // Set when the editor was filled with a copy of another revision (A for A*, B for C).
  derivedFromRevisionId: id.nullish(),
  annotatorLabel: label.optional(),
  // true: the transcript status becomes needs_review instead of draft.
  needsReview: z.boolean().optional(),
  // The current revision the editor was loaded with (null: none existed). When
  // given and another revision has become current since, the save is rejected
  // with CONFLICT instead of silently replacing the other researcher's text.
  expectedCurrentRevisionId: id.nullable().optional(),
});
export type SaveRevisionBody = z.input<typeof saveRevisionBodySchema>;

// Body of POST /api/admin/transcripts/:id/verify.
export const verifyTranscriptBodySchema = z.object({
  revisionId: id,
  verificationNotes: optionalText(MAX_NOTE_LENGTH),
  verifiedByLabel: label.optional(),
});
export type VerifyTranscriptBody = z.input<typeof verifyTranscriptBodySchema>;

// Body of POST /api/admin/transcripts/:id/status.
export const setTranscriptStatusBodySchema = z.object({
  status: z.enum(SETTABLE_TRANSCRIPT_STATUSES),
});
export type SetTranscriptStatusBody = z.input<typeof setTranscriptStatusBodySchema>;

// ---------------------------------------------------------------------------
// Difference coding (spec 19)
// ---------------------------------------------------------------------------

const offset = z.number().int().min(0);

// Body of POST /api/admin/utterances/:id/annotations.
export const differenceAnnotationBodySchema = z
  .object({
    sourceTranscriptRevisionId: id,
    targetTranscriptRevisionId: id,
    // Several categories may apply. An empty list records "no difference coded",
    // which is also how an annotator takes back an earlier coding (rows are never overwritten).
    categories: z.array(z.enum(DIFFERENCE_CATEGORIES)).max(DIFFERENCE_CATEGORIES.length),
    notes: optionalText(MAX_NOTE_LENGTH),
    annotatorLabel: label.optional(),
    scope: z.enum(ANNOTATION_SCOPES).default("utterance"),
    // Character offsets into the revision texts, end exclusive. Only for scope "span".
    sourceStart: offset.nullish(),
    sourceEnd: offset.nullish(),
    targetStart: offset.nullish(),
    targetEnd: offset.nullish(),
  })
  .superRefine((value, context) => {
    if (value.sourceTranscriptRevisionId === value.targetTranscriptRevisionId) {
      context.addIssue({
        code: "custom",
        path: ["targetTranscriptRevisionId"],
        message: "The two revisions must be different.",
      });
    }
    const pairs = [
      ["sourceStart", "sourceEnd"],
      ["targetStart", "targetEnd"],
    ] as const;
    const hasAnyOffset = pairs.some(([start, end]) => value[start] != null || value[end] != null);
    if (value.scope === "utterance" && hasAnyOffset) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Character offsets are only allowed with the scope span.",
      });
    }
    if (value.scope === "span") {
      let completePairs = 0;
      for (const [startKey, endKey] of pairs) {
        const start = value[startKey];
        const end = value[endKey];
        if (start == null && end == null) continue;
        if (start == null || end == null) {
          context.addIssue({ code: "custom", path: [endKey], message: "Give both the start and the end." });
        } else if (end < start) {
          context.addIssue({ code: "custom", path: [endKey], message: "The end is before the start." });
        } else {
          completePairs += 1;
        }
      }
      if (completePairs === 0) {
        context.addIssue({
          code: "custom",
          path: ["scope"],
          message: "A span annotation needs offsets in the source text, the target text or both.",
        });
      }
    }
  });
export type DifferenceAnnotationBody = z.input<typeof differenceAnnotationBodySchema>;

// ---------------------------------------------------------------------------
// Flags and notes (spec 66, 71, 88)
// ---------------------------------------------------------------------------

// Body of POST /api/admin/utterances/:id/flags. Without transcriptId the flag is
// on the utterance, with it on that transcript of the utterance.
export const addFlagBodySchema = z.object({
  transcriptId: id.optional(),
  reasonCode: z.enum(FLAG_REASON_CODES),
  notes: optionalText(MAX_NOTE_LENGTH),
  annotatorLabel: label.optional(),
});
export type AddFlagBody = z.input<typeof addFlagBodySchema>;

// Body of POST /api/admin/utterances/:id/notes.
export const addNoteBodySchema = z.object({
  transcriptId: id.optional(),
  body: z.string().trim().min(1).max(MAX_NOTE_LENGTH),
  annotatorLabel: label.optional(),
});
export type AddNoteBody = z.input<typeof addNoteBodySchema>;

// Body of POST /api/admin/review/flags/:id/resolve (may be empty).
export const resolveFlagBodySchema = z.object({ annotatorLabel: label.optional() });

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

const oneOrMany = <T extends z.ZodType>(item: T) =>
  z.union([item, z.array(item)]).transform((value) => (Array.isArray(value) ? value : [value]));

// Query string of GET /api/admin/review/queue. Repeat `condition` and `mode` to give several.
export const reviewQueueQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(REVIEW_QUEUE_MAX_PAGE_SIZE).default(REVIEW_QUEUE_DEFAULT_PAGE_SIZE),
  condition: oneOrMany(z.enum(REVIEW_QUEUE_CONDITIONS)).optional(),
  taskType: z.enum(TASK_TYPES).optional(),
  protocolVersionId: id.optional(),
  // Default: research only. TEST and DEMO rows appear only when asked for.
  mode: oneOrMany(z.enum(STUDY_MODES)).optional(),
  // Matched with ILIKE against the current transcript revisions, the participant
  // code and the start of the utterance id. PostgreSQL only (spec 117).
  search: optionalText(200),
  // Matched with ILIKE against the answer to the questionnaire item `regionItemKey`.
  region: optionalText(100),
  regionItemKey: optionalText(100),
  includeExcluded: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type ReviewQueueQuery = z.output<typeof reviewQueueQuerySchema>;

// ---------------------------------------------------------------------------
// Response types. Timestamps are ISO 8601 strings in UTC.
// ---------------------------------------------------------------------------

export type ModelRunSummary = {
  id: string;
  provider: string;
  requestedModel: string;
  returnedModel: string | null;
  status: string;
  finishedAt: string | null;
  processingBatchId: string | null;
};

export type TranscriptRevisionView = {
  id: string;
  transcriptId: string;
  revisionNumber: number;
  text: string;
  createdByType: RevisionAuthorType;
  createdByLabel: string | null;
  changeReason: string | null;
  transcriptionConventionVersion: string | null;
  isCurrent: boolean;
  createdAt: string;
  verifiedAt: string | null;
  verifiedByLabel: string | null;
  verificationNotes: string | null;
  derivedFromRevisionId: string | null;
  sourceModelRunId: string | null;
};

export type TranscriptView = {
  id: string;
  utteranceId: string;
  type: TranscriptType;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  revisionCount: number;
  currentRevision: TranscriptRevisionView | null;
  // Only for the ASR transcript: the model run that produced the current revision.
  modelRun: ModelRunSummary | null;
};

export type SaveRevisionResponse = {
  transcript: TranscriptView;
  revision: TranscriptRevisionView;
  // false when the text was identical to the current revision and nothing was written.
  created: boolean;
};

export type VerifyTranscriptResponse = { transcript: TranscriptView; revision: TranscriptRevisionView };
export type SetTranscriptStatusResponse = { transcript: TranscriptView };

export type TranscriptHistoryResponse = {
  transcript: TranscriptView;
  // Newest first.
  revisions: TranscriptRevisionView[];
};

export type DifferenceAnnotationView = {
  id: string;
  utteranceId: string;
  sourceTranscriptRevisionId: string | null;
  targetTranscriptRevisionId: string | null;
  // Resolved for display: which transcript and revision number each side is.
  sourceTranscriptType: TranscriptType | null;
  sourceRevisionNumber: number | null;
  targetTranscriptType: TranscriptType | null;
  targetRevisionNumber: number | null;
  scope: AnnotationScope;
  sourceStart: number | null;
  sourceEnd: number | null;
  targetStart: number | null;
  targetEnd: number | null;
  categories: DifferenceCategory[];
  notes: string | null;
  annotatorLabel: string;
  schemeVersion: string;
  createdAt: string;
};

export type DifferenceAnnotationsView = {
  // The newest row per annotator, revision pair, scope and span.
  latest: DifferenceAnnotationView[];
  // Every row, newest first. Earlier codings are kept, never overwritten.
  history: DifferenceAnnotationView[];
};

export type ReviewFlagView = {
  id: string;
  entityType: string;
  entityId: string;
  // Set when the flag is on a transcript.
  transcriptType: TranscriptType | null;
  reasonCode: FlagReasonCode | string | null;
  notes: string | null;
  createdByLabel: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type ReviewNoteView = {
  id: string;
  entityType: string;
  entityId: string;
  transcriptType: TranscriptType | null;
  body: string;
  createdByLabel: string | null;
  createdAt: string;
};

export type ReviewMediaView = {
  id: string;
  kind: string;
  mimeType: string;
  container: string | null;
  codec: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  bitDepth: number | null;
  durationMs: number | null;
  sizeBytes: number;
  sha256: string;
  captureMethod: string | null;
  captureQualityClass: string | null;
  // True when the file was removed by the audited media deletion workflow.
  deleted: boolean;
};

export type UtteranceForReview = {
  utterance: {
    id: string;
    status: UtteranceStatus;
    // Exact prompt text the participant answered.
    promptSnapshot: string;
    turnIndex: number;
    isFollowup: boolean;
    durationMs: number | null;
    submittedAt: string | null;
    attemptCount: number;
    flagged: boolean;
    flagNotes: string | null;
    exclusionReason: string | null;
  };
  session: {
    id: string;
    participantCode: string;
    mode: StudyMode;
    status: SessionStatus;
    excluded: boolean;
    protocolVersionId: string;
    protocolVersionNumber: number;
  };
  task: {
    taskKey: string;
    taskType: TaskType;
    titleSnapshot: string;
    promptSnapshot: string;
    contextSnapshot: string | null;
    instructionsSnapshot: string | null;
    sequenceIndex: number;
  };
  // The accepted source recording. Play it through GET /api/admin/media/:id.
  media: ReviewMediaView | null;
  transcripts: Record<TranscriptType, TranscriptView | null>;
  differenceAnnotations: DifferenceAnnotationsView;
  flags: ReviewFlagView[];
  notes: ReviewNoteView[];
  settings: {
    adminTimezone: string;
    transcriptionConventionVersion: string | null;
    annotationSchemeVersion: string | null;
  };
};

export type ReviewQueueTranscriptState = {
  transcriptId: string;
  status: ReviewStatus;
  hasRevision: boolean;
};

export type ReviewQueueRow = {
  utteranceId: string;
  sessionId: string;
  participantCode: string;
  mode: StudyMode;
  sessionStatus: SessionStatus;
  utteranceStatus: UtteranceStatus;
  taskType: TaskType;
  taskKey: string;
  taskTitle: string;
  turnIndex: number;
  durationMs: number | null;
  submittedAt: string | null;
  // null: no transcript row of this type exists.
  transcripts: Record<TranscriptType, ReviewQueueTranscriptState | null>;
  flagged: boolean;
  openFlagCount: number;
  // Neighbors in the filtered queue order at the time of the request, also
  // across page borders. null at the start and at the end of the queue.
  previousId: string | null;
  nextId: string | null;
};

export type ReviewQueueResponse = {
  rows: ReviewQueueRow[];
  page: number;
  pageSize: number;
  total: number;
  // Filter choices for the page.
  protocolVersions: { id: string; versionNumber: number; name: string; status: string }[];
  adminTimezone: string;
};

export type AddFlagResponse = { flag: ReviewFlagView };
export type ResolveFlagResponse = { flag: ReviewFlagView };
export type AddNoteResponse = { note: ReviewNoteView };
export type SaveDifferenceAnnotationResponse = { annotation: DifferenceAnnotationView };

// ---------------------------------------------------------------------------
// Difference categories offered for a transcript pair (spec 19)
// ---------------------------------------------------------------------------

// A recognition error is an error of the speech recognizer, so it can only be
// coded for a pair that involves a recognizer output (A, or A* which is A with
// corrections). For B versus C both texts were written by a person, and the
// relevant categories are the remaining ones.
//
// This list only decides what the review page OFFERS. The stored values and the
// request schema keep accepting every category of DIFFERENCE_CATEGORIES, so
// codings saved before this rule stay valid and readable.
const RECOGNIZER_TRANSCRIPT_TYPES: readonly TranscriptType[] = ["asr", "asr_corrected"];

export function differenceCategoriesForPair(source: TranscriptType, target: TranscriptType): DifferenceCategory[] {
  const involvesRecognizer =
    RECOGNIZER_TRANSCRIPT_TYPES.includes(source) || RECOGNIZER_TRANSCRIPT_TYPES.includes(target);
  return DIFFERENCE_CATEGORIES.filter((category) => involvesRecognizer || category !== "recognition_error");
}

// ---------------------------------------------------------------------------
// Is the normalized transcript (C) still based on the current B?
// ---------------------------------------------------------------------------

// C is written from B (spec 16). When B gets a new revision after C was made,
// C may no longer match it. Two cases are reported:
//   derived_from_older_revision  C records the B revision it was copied from,
//                                and that is not the current B revision;
//   source_changed_later         C records no derivation (it was typed by hand)
//                                and the current B revision was saved after the
//                                current C revision.
// The result is a note for the researcher. It blocks nothing.
export type NormalizedDerivationWarning = {
  kind: "derived_from_older_revision" | "source_changed_later";
  dialectRevisionNumber: number;
  normalizedRevisionNumber: number;
  message: string;
};

type DerivationRevision = Pick<TranscriptRevisionView, "id" | "revisionNumber" | "createdAt" | "derivedFromRevisionId">;

export function normalizedDerivationWarning(
  dialect: DerivationRevision | null | undefined,
  normalized: DerivationRevision | null | undefined,
): NormalizedDerivationWarning | null {
  if (!dialect || !normalized) return null;
  const numbers = { dialectRevisionNumber: dialect.revisionNumber, normalizedRevisionNumber: normalized.revisionNumber };
  if (normalized.derivedFromRevisionId !== null) {
    if (normalized.derivedFromRevisionId === dialect.id) return null;
    return {
      kind: "derived_from_older_revision",
      ...numbers,
      message: `C revision ${normalized.revisionNumber} was copied from an earlier revision of B. B is now at revision ${dialect.revisionNumber}. Check that C still matches B.`,
    };
  }
  if (Date.parse(dialect.createdAt) > Date.parse(normalized.createdAt)) {
    return {
      kind: "source_changed_later",
      ...numbers,
      message: `B was changed (revision ${dialect.revisionNumber}) after C revision ${normalized.revisionNumber} was saved. Check that C still matches B.`,
    };
  }
  return null;
}
