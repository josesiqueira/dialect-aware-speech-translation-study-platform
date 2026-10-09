// Central list of the allowed values used across the database, services, API and UI.
// Spec reference: sections 14, 17, 19, 27, 28, 29, 37, 78, 168.
// Add a value here first, then generate a database migration.

export const STUDY_MODES = ["research", "demo", "test"] as const;
export type StudyMode = (typeof STUDY_MODES)[number];

export const STUDY_STATUSES = ["active", "paused", "closed"] as const;
export type StudyStatus = (typeof STUDY_STATUSES)[number];

export const TASK_TYPES = ["controlled", "semi_structured", "free_speech"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const ORDER_MODES = ["fixed", "shuffle_within_block"] as const;
export type OrderMode = (typeof ORDER_MODES)[number];

// Used by protocol versions and questionnaire versions.
export const PUBLICATION_STATUSES = ["draft", "published", "retired"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

// Used by AI prompt versions and model configs.
export const CONFIG_STATUSES = ["draft", "active", "retired"] as const;
export type ConfigStatus = (typeof CONFIG_STATUSES)[number];

export const SESSION_STATUSES = [
  "created",
  "consented",
  "mic_check",
  "recording",
  "background_questionnaire",
  "post_questionnaire",
  "completed",
  "withdrawn",
  "abandoned",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const TERMINAL_SESSION_STATUSES = ["completed", "withdrawn", "abandoned"] as const;

export const PRESENTATION_STATUSES = ["pending", "started", "completed", "skipped"] as const;
export type PresentationStatus = (typeof PRESENTATION_STATUSES)[number];

export const UTTERANCE_STATUSES = [
  "recording",
  "uploading",
  "submitted",
  "invalid",
  "excluded",
] as const;
export type UtteranceStatus = (typeof UTTERANCE_STATUSES)[number];

export const MEDIA_KINDS = [
  "source_audio",
  "source_audio_raw",
  "source_audio_derived",
  "tts_audio",
  "realtime_translation_audio",
  "export_archive",
  "other",
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const CAPTURE_METHODS = ["audio_worklet_pcm", "media_recorder"] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

// Coarse class of the input device, derived in the browser from the device label
// by classifyInputDevice() in validators/sessions.ts. The label itself is never
// stored: it can contain a person's name ("Anna's AirPods").
export const INPUT_DEVICE_CLASSES = ["built_in", "usb", "bluetooth", "headset", "unknown"] as const;
export type InputDeviceClass = (typeof INPUT_DEVICE_CLASSES)[number];

// Scope labels of consent items (consent_versions.items_json[].scope). The
// column is free text. These are the labels the application itself acts on or
// that the development seed uses.
export const CONSENT_SCOPES = {
  participation: "participation",
  voiceRecording: "voice_recording",
  // Sending audio or text to an external AI provider. Automatic transcription
  // after an upload runs only for a session that accepted an item with this scope.
  externalAiProcessing: "external_ai_processing",
  futureResearchReuse: "future_research_reuse",
  // Seeing the AI output of one's own recordings at the end of the session and
  // rating it (the output review). The review runs only for a session that
  // accepted an item with this scope and an item with external_ai_processing.
  outputReview: "output_review",
} as const;
export const CONSENT_SCOPE_EXTERNAL_AI_PROCESSING = CONSENT_SCOPES.externalAiProcessing;
export const CONSENT_SCOPE_OUTPUT_REVIEW = CONSENT_SCOPES.outputReview;

export const CAPTURE_QUALITY_CLASSES = ["lossless_pcm", "compressed_fallback"] as const;
export type CaptureQualityClass = (typeof CAPTURE_QUALITY_CLASSES)[number];

// A = asr, A* = asr_corrected, B = human_dialect, C = normalized.
export const TRANSCRIPT_TYPES = ["asr", "asr_corrected", "human_dialect", "normalized"] as const;
export type TranscriptType = (typeof TRANSCRIPT_TYPES)[number];

export const TRANSCRIPT_TYPE_LABELS: Record<TranscriptType, string> = {
  asr: "A",
  asr_corrected: "A*",
  human_dialect: "B",
  normalized: "C",
};

export const REVIEW_STATUSES = ["not_started", "draft", "needs_review", "verified"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVISION_AUTHOR_TYPES = ["model", "researcher", "system"] as const;
export type RevisionAuthorType = (typeof REVISION_AUTHOR_TYPES)[number];

export const PROCESSING_STAGES = ["asr", "translation", "tts", "realtime_translation"] as const;
export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

export const MODEL_RUN_STAGES = [...PROCESSING_STAGES, "automatic_metric", "other"] as const;
export type ModelRunStage = (typeof MODEL_RUN_STAGES)[number];

export const MODEL_RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type ModelRunStatus = (typeof MODEL_RUN_STATUSES)[number];

// Translation condition keys seeded for the first study. The database column is
// plain text so researchers can add conditions without a schema change.
export const TRANSLATION_CONDITIONS = ["default", "preservation"] as const;
export type TranslationCondition = (typeof TRANSLATION_CONDITIONS)[number];

export const TTS_BASELINE_CONDITION = "baseline";

export const BATCH_STATUSES = [
  "draft",
  "queued",
  "running",
  "completed",
  "completed_with_errors",
  "cancelled",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const OUTPUT_STATUSES = ["generated", "reviewed", "excluded"] as const;
export type OutputStatus = (typeof OUTPUT_STATUSES)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// jobs.type is a text column, so a new type needs no migration.
// delete_storage_object: removes a stored file whose database row is already gone.
export const JOB_TYPES = ["asr", "translation", "tts", "derive_wav", "export", "delete_storage_object"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const EXPORT_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

export const QUESTIONNAIRE_ITEM_TYPES = [
  "likert",
  "single_choice",
  "multi_choice",
  "free_text",
  "integer",
  "short_text",
  "boolean",
] as const;
export type QuestionnaireItemType = (typeof QUESTIONNAIRE_ITEM_TYPES)[number];

// Keys that link a questionnaire to its place in the participant flow.
// post_review follows the output review (docs/RESEARCH-DESIGN.md, section 3).
export const QUESTIONNAIRE_KEYS = ["background", "post_recording", "post_review"] as const;
export type QuestionnaireKey = (typeof QUESTIONNAIRE_KEYS)[number];

export const ANNOTATION_SCOPES = ["utterance", "span"] as const;
export type AnnotationScope = (typeof ANNOTATION_SCOPES)[number];

// Spec section 19. Several categories may apply to one difference.
export const DIFFERENCE_CATEGORIES = [
  "recognition_error",
  "normalization",
  "omission",
  "addition",
  "segmentation",
  "punctuation_or_formatting",
  "uncertain",
] as const;
export type DifferenceCategory = (typeof DIFFERENCE_CATEGORIES)[number];

// Spec section 2.2. Labels for how a source feature fared in a derived output.
export const TRANSFER_LABELS = [
  "retained",
  "functionally_reformulated",
  "compensated_elsewhere",
  "neutralized",
  "distorted",
  "exaggerated_or_invented",
  "not_transferable",
  "uncertain",
] as const;
export type TransferLabel = (typeof TRANSFER_LABELS)[number];

export const FLAG_REASON_CODES = [
  "contains_third_party_identifier",
  "poor_audio",
  "asr_problem",
  "interesting_dialect_feature",
  "translation_problem",
  "tts_problem",
  "needs_expert_review",
  "other",
] as const;
export type FlagReasonCode = (typeof FLAG_REASON_CODES)[number];

// Entity types used by flags, notes, audit log, model run sources and media owners.
export const ENTITY_TYPES = [
  "study",
  "protocol_version",
  "consent_version",
  "questionnaire_version",
  "session",
  "task_presentation",
  "utterance",
  "media_asset",
  "transcript",
  "transcript_revision",
  "translation",
  "synthesis",
  "ai_prompt_version",
  "model_config",
  "processing_batch",
  "model_run",
  "job",
  "export_job",
  "annotation",
  "admin_session",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const EXPORT_PRIVACY_TIERS = [
  "internal_full",
  "analysis_pseudonymous",
  "collaboration_restricted",
  "public_release",
] as const;
export type ExportPrivacyTier = (typeof EXPORT_PRIVACY_TIERS)[number];

// Audit actions (spec section 37.26).
export const AUDIT_ACTIONS = [
  "protocol.create",
  "protocol.update_draft",
  "protocol.clone",
  "protocol.publish",
  "protocol.retire",
  "protocol.delete_draft",
  "consent.create",
  "consent.update_draft",
  "consent.publish",
  "consent.delete_draft",
  "consent.clone",
  "questionnaire.create",
  "questionnaire.update_draft",
  "questionnaire.publish",
  "questionnaire.retire",
  "questionnaire.delete_draft",
  "transcript.save_revision",
  "transcript.verify",
  "transcript.revise_verified",
  "transcript.set_status",
  "annotation.create",
  "ai_prompt.create",
  "ai_prompt.update_draft",
  "ai_prompt.activate",
  "ai_prompt.retire",
  "ai_prompt.delete_draft",
  "model_config.create",
  "model_config.update_draft",
  "model_config.activate",
  "model_config.retire",
  "model_config.delete_draft",
  "media.delete",
  "utterance.exclude",
  "utterance.include",
  "session.exclude",
  "session.include",
  "session.flag",
  "session.unflag",
  "utterance.flag",
  "utterance.unflag",
  "flag.create",
  "flag.resolve",
  "output.set_status",
  "media.download",
  "note.create",
  "batch.create",
  "batch.start",
  "batch.cancel",
  "batch.retry_failed",
  "export.create",
  "export.download",
  "test_data.reset",
  "settings.update",
  "pipeline_test.run",
  "admin.login",
  "admin.login_failed",
  "admin.logout",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// Output review (docs/RESEARCH-DESIGN.md, section 3; reports/Source speaker
// output evaluation.md). The participant rates the AI output of their own
// recordings after all speaking tasks and the first questionnaires.
//   utterance: one of the participant's own recordings. The only kind the
//              review plans since scale version output-review-v2.
//   practice, check, audio: kinds of the first version (output-review-v1),
//              which also showed a practice example, a prepared check example
//              and an audio screen. Kept so that rows stored with v1 stay valid.
export const OUTPUT_REVIEW_ITEM_KINDS = ["practice", "utterance", "check", "audio"] as const;
export type OutputReviewItemKind = (typeof OUTPUT_REVIEW_ITEM_KINDS)[number];

//   in_progress: items are selected and being answered;
//   completed:   every item is answered;
//   skipped:     the participant chose to skip this part (skipped_at_step says where);
//   unavailable: no recording had both translations in time, so nothing was shown.
export const OUTPUT_REVIEW_STATUSES = ["in_progress", "completed", "skipped", "unavailable"] as const;
export type OutputReviewStatus = (typeof OUTPUT_REVIEW_STATUSES)[number];

// The two translation conditions compared in the review (spec 20). The
// participant only ever sees "Version 1" and "Version 2".
export const OUTPUT_REVIEW_CONDITION_KEYS = ["default", "preservation"] as const;

// Version of the review questions and their scales. Stored with every answer.
// v1: transcript said and reads, four ratings per version, forced choice,
//     practice, check and audio screens.
// v2: transcript "Is this what you said?" (yes, partly, no), and per version
//     meaning and representation, each 1 to 5 or "can't say".
export const OUTPUT_REVIEW_SCALE_VERSION = "output-review-v2";
