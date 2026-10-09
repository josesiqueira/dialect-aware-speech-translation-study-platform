CREATE TYPE "public"."annotation_scope" AS ENUM('utterance', 'span');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('draft', 'queued', 'running', 'completed', 'completed_with_errors', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."config_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."export_job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('source_audio', 'source_audio_raw', 'source_audio_derived', 'tts_audio', 'realtime_translation_audio', 'export_archive', 'other');--> statement-breakpoint
CREATE TYPE "public"."model_run_stage" AS ENUM('asr', 'translation', 'tts', 'realtime_translation', 'automatic_metric', 'other');--> statement-breakpoint
CREATE TYPE "public"."model_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."order_mode" AS ENUM('fixed', 'shuffle_within_block');--> statement-breakpoint
CREATE TYPE "public"."output_status" AS ENUM('generated', 'reviewed', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."presentation_status" AS ENUM('pending', 'started', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."processing_stage" AS ENUM('asr', 'translation', 'tts', 'realtime_translation');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."questionnaire_item_type" AS ENUM('likert', 'single_choice', 'multi_choice', 'free_text', 'integer', 'short_text', 'boolean');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('not_started', 'draft', 'needs_review', 'verified');--> statement-breakpoint
CREATE TYPE "public"."revision_author_type" AS ENUM('model', 'researcher', 'system');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('created', 'consented', 'mic_check', 'recording', 'background_questionnaire', 'post_questionnaire', 'completed', 'withdrawn', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."study_mode" AS ENUM('research', 'demo', 'test');--> statement-breakpoint
CREATE TYPE "public"."study_status" AS ENUM('active', 'paused', 'closed');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('controlled', 'semi_structured', 'free_speech');--> statement-breakpoint
CREATE TYPE "public"."transcript_type" AS ENUM('asr', 'asr_corrected', 'human_dialect', 'normalized');--> statement-breakpoint
CREATE TYPE "public"."utterance_status" AS ENUM('recording', 'uploading', 'submitted', 'invalid', 'excluded');--> statement-breakpoint
CREATE TABLE "consent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"title" text NOT NULL,
	"information_text" text NOT NULL,
	"privacy_notice_url" text,
	"contact_text" text,
	"items_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"created_by_label" text
);
--> statement-breakpoint
CREATE TABLE "protocol_task_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_task_id" uuid NOT NULL,
	"followup_key" text NOT NULL,
	"prompt_text" text NOT NULL,
	"order_index" integer NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_version_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"internal_name" text,
	"task_type" "task_type" NOT NULL,
	"title" text NOT NULL,
	"participant_prompt" text NOT NULL,
	"context_text" text,
	"instructions_text" text,
	"block_key" text NOT NULL,
	"order_index" integer NOT NULL,
	"order_mode" "order_mode" DEFAULT 'fixed' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_duration_seconds" integer,
	"suggested_duration_seconds" integer,
	"max_duration_seconds" integer,
	"privacy_reminder" boolean DEFAULT false NOT NULL,
	"researcher_notes" text,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "publication_status" DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"welcome_content" text DEFAULT '' NOT NULL,
	"information_content" text DEFAULT '' NOT NULL,
	"instruction_content" text DEFAULT '' NOT NULL,
	"debrief_content" text DEFAULT '' NOT NULL,
	"consent_version_id" uuid,
	"background_questionnaire_version_id" uuid,
	"post_questionnaire_version_id" uuid,
	"order_config_json" jsonb DEFAULT '{"blocks":[]}'::jsonb NOT NULL,
	"cloned_from_protocol_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_by_label" text
);
--> statement-breakpoint
CREATE TABLE "questionnaire_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"type" "questionnaire_item_type" NOT NULL,
	"prompt" text NOT NULL,
	"help_text" text,
	"required" boolean DEFAULT false NOT NULL,
	"order_index" integer NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questionnaire_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version_number" integer NOT NULL,
	"status" "publication_status" DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_by_label" text
);
--> statement-breakpoint
CREATE TABLE "rate_limit_hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "study_status" DEFAULT 'active' NOT NULL,
	"current_protocol_version_id" uuid,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"info_json" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"session_id" uuid,
	"utterance_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"kind" "media_kind" NOT NULL,
	"storage_driver" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"container" text,
	"codec" text,
	"sample_rate_hz" integer,
	"channels" integer,
	"bit_depth" integer,
	"duration_ms" integer,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"capture_method" text,
	"capture_quality_class" text,
	"derived_from_media_asset_id" uuid,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "questionnaire_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_id" uuid NOT NULL,
	"questionnaire_item_id" uuid NOT NULL,
	"value_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "questionnaire_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"questionnaire_version_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"consent_version_id" uuid NOT NULL,
	"responses_json" jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"participant_code" text NOT NULL,
	"protocol_version_id" uuid NOT NULL,
	"mode" "study_mode" NOT NULL,
	"status" "session_status" DEFAULT 'created' NOT NULL,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"locale" text,
	"order_seed" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consented_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"browser_info_json" jsonb,
	"audio_environment_json" jsonb,
	"app_version" text NOT NULL,
	"git_commit_sha" text,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_notes" text,
	"excluded" boolean DEFAULT false NOT NULL,
	"exclusion_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_participant_code_unique" UNIQUE("participant_code"),
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "task_presentations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"protocol_task_id" uuid NOT NULL,
	"sequence_index" integer NOT NULL,
	"title_snapshot" text NOT NULL,
	"prompt_snapshot" text NOT NULL,
	"context_snapshot" text,
	"instructions_snapshot" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"status" "presentation_status" DEFAULT 'pending' NOT NULL,
	"randomization_metadata_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "utterances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"task_presentation_id" uuid NOT NULL,
	"followup_id" uuid,
	"prompt_snapshot" text NOT NULL,
	"turn_index" integer NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"accepted_media_asset_id" uuid,
	"submitted_at" timestamp with time zone,
	"duration_ms" integer,
	"status" "utterance_status" DEFAULT 'recording' NOT NULL,
	"exclusion_reason" text,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_notes" text,
	"quality_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"key" text NOT NULL,
	"stage" "processing_stage" NOT NULL,
	"condition_key" text,
	"version_number" integer NOT NULL,
	"status" "config_status" DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"prompt_text" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_by_label" text
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"export_type" text NOT NULL,
	"privacy_tier" text DEFAULT 'internal_full' NOT NULL,
	"filters_json" jsonb NOT NULL,
	"status" "export_job_status" DEFAULT 'queued' NOT NULL,
	"media_asset_id" uuid,
	"file_name" text,
	"summary_json" jsonb,
	"error_message" text,
	"created_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"processing_batch_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "model_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"key" text NOT NULL,
	"stage" "processing_stage" NOT NULL,
	"condition_key" text,
	"version_number" integer NOT NULL,
	"status" "config_status" DEFAULT 'draft' NOT NULL,
	"name" text,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"parameters_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_version_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_by_label" text
);
--> statement-breakpoint
CREATE TABLE "model_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" "model_run_stage" NOT NULL,
	"provider" text NOT NULL,
	"requested_model" text NOT NULL,
	"returned_model" text,
	"model_config_id" uuid,
	"prompt_version_id" uuid,
	"processing_batch_id" uuid,
	"condition_key" text,
	"source_entity_type" text NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"parameters_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_manifest_json" jsonb NOT NULL,
	"provider_request_id" text,
	"status" "model_run_status" DEFAULT 'running' NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"latency_ms" integer,
	"usage_json" jsonb,
	"estimated_cost" numeric(12, 6),
	"response_metadata_json" jsonb,
	"error_code" text,
	"error_message" text,
	"app_version" text NOT NULL,
	"git_commit_sha" text,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "model_runs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "processing_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "batch_status" DEFAULT 'draft' NOT NULL,
	"data_mode" "study_mode" DEFAULT 'research' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"configuration_snapshot_json" jsonb NOT NULL,
	"created_by_label" text
);
--> statement-breakpoint
CREATE TABLE "syntheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"translation_id" uuid,
	"source_text" text NOT NULL,
	"condition_key" text NOT NULL,
	"processing_batch_id" uuid NOT NULL,
	"model_run_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"voice_key" text NOT NULL,
	"repetition_index" integer DEFAULT 0 NOT NULL,
	"status" "output_status" DEFAULT 'generated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"text" text NOT NULL,
	"segments_json" jsonb,
	"source_model_run_id" uuid,
	"derived_from_revision_id" uuid,
	"created_by_type" "revision_author_type" NOT NULL,
	"created_by_label" text,
	"change_reason" text,
	"transcription_convention_version" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_label" text,
	"verification_notes" text
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utterance_id" uuid NOT NULL,
	"type" "transcript_type" NOT NULL,
	"status" "review_status" DEFAULT 'not_started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_transcript_revision_id" uuid NOT NULL,
	"condition_key" text NOT NULL,
	"processing_batch_id" uuid NOT NULL,
	"model_run_id" uuid NOT NULL,
	"translated_text" text NOT NULL,
	"target_language" text DEFAULT 'en' NOT NULL,
	"repetition_index" integer DEFAULT 0 NOT NULL,
	"status" "output_status" DEFAULT 'generated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before_json" jsonb,
	"after_json" jsonb,
	"actor_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "difference_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utterance_id" uuid NOT NULL,
	"source_transcript_revision_id" uuid,
	"target_transcript_revision_id" uuid,
	"annotation_scope" "annotation_scope" DEFAULT 'utterance' NOT NULL,
	"source_start" integer,
	"source_end" integer,
	"target_start" integer,
	"target_end" integer,
	"categories_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"annotator_label" text NOT NULL,
	"scheme_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"feature_family" text NOT NULL,
	"feature_key" text NOT NULL,
	"source_span_json" jsonb,
	"target_span_json" jsonb,
	"label" text NOT NULL,
	"function_label" text,
	"confidence" numeric(4, 3),
	"notes" text,
	"annotator_label" text NOT NULL,
	"scheme_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason_code" text,
	"notes" text,
	"created_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_versions" ADD CONSTRAINT "consent_versions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_task_followups" ADD CONSTRAINT "protocol_task_followups_protocol_task_id_protocol_tasks_id_fk" FOREIGN KEY ("protocol_task_id") REFERENCES "public"."protocol_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_tasks" ADD CONSTRAINT "protocol_tasks_protocol_version_id_protocol_versions_id_fk" FOREIGN KEY ("protocol_version_id") REFERENCES "public"."protocol_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_consent_version_id_consent_versions_id_fk" FOREIGN KEY ("consent_version_id") REFERENCES "public"."consent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_background_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("background_questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_post_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("post_questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_cloned_from_protocol_version_id_protocol_versions_id_fk" FOREIGN KEY ("cloned_from_protocol_version_id") REFERENCES "public"."protocol_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_items" ADD CONSTRAINT "questionnaire_items_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studies" ADD CONSTRAINT "studies_current_protocol_version_id_protocol_versions_id_fk" FOREIGN KEY ("current_protocol_version_id") REFERENCES "public"."protocol_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_utterance_id_utterances_id_fk" FOREIGN KEY ("utterance_id") REFERENCES "public"."utterances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_derived_from_media_asset_id_media_assets_id_fk" FOREIGN KEY ("derived_from_media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_answers" ADD CONSTRAINT "questionnaire_answers_response_id_questionnaire_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."questionnaire_responses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_answers" ADD CONSTRAINT "questionnaire_answers_questionnaire_item_id_questionnaire_items_id_fk" FOREIGN KEY ("questionnaire_item_id") REFERENCES "public"."questionnaire_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_consents" ADD CONSTRAINT "session_consents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_consents" ADD CONSTRAINT "session_consents_consent_version_id_consent_versions_id_fk" FOREIGN KEY ("consent_version_id") REFERENCES "public"."consent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_protocol_version_id_protocol_versions_id_fk" FOREIGN KEY ("protocol_version_id") REFERENCES "public"."protocol_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_presentations" ADD CONSTRAINT "task_presentations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_presentations" ADD CONSTRAINT "task_presentations_protocol_task_id_protocol_tasks_id_fk" FOREIGN KEY ("protocol_task_id") REFERENCES "public"."protocol_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_task_presentation_id_task_presentations_id_fk" FOREIGN KEY ("task_presentation_id") REFERENCES "public"."task_presentations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_followup_id_protocol_task_followups_id_fk" FOREIGN KEY ("followup_id") REFERENCES "public"."protocol_task_followups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_accepted_media_asset_id_media_assets_id_fk" FOREIGN KEY ("accepted_media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_prompt_versions" ADD CONSTRAINT "ai_prompt_versions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_processing_batch_id_processing_batches_id_fk" FOREIGN KEY ("processing_batch_id") REFERENCES "public"."processing_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_prompt_version_id_ai_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."ai_prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_model_config_id_model_configs_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_prompt_version_id_ai_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."ai_prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_processing_batch_id_processing_batches_id_fk" FOREIGN KEY ("processing_batch_id") REFERENCES "public"."processing_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_batches" ADD CONSTRAINT "processing_batches_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syntheses" ADD CONSTRAINT "syntheses_translation_id_translations_id_fk" FOREIGN KEY ("translation_id") REFERENCES "public"."translations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syntheses" ADD CONSTRAINT "syntheses_processing_batch_id_processing_batches_id_fk" FOREIGN KEY ("processing_batch_id") REFERENCES "public"."processing_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syntheses" ADD CONSTRAINT "syntheses_model_run_id_model_runs_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."model_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syntheses" ADD CONSTRAINT "syntheses_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_revisions" ADD CONSTRAINT "transcript_revisions_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_revisions" ADD CONSTRAINT "transcript_revisions_source_model_run_id_model_runs_id_fk" FOREIGN KEY ("source_model_run_id") REFERENCES "public"."model_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_revisions" ADD CONSTRAINT "transcript_revisions_derived_from_revision_id_transcript_revisions_id_fk" FOREIGN KEY ("derived_from_revision_id") REFERENCES "public"."transcript_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_utterance_id_utterances_id_fk" FOREIGN KEY ("utterance_id") REFERENCES "public"."utterances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_source_transcript_revision_id_transcript_revisions_id_fk" FOREIGN KEY ("source_transcript_revision_id") REFERENCES "public"."transcript_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_processing_batch_id_processing_batches_id_fk" FOREIGN KEY ("processing_batch_id") REFERENCES "public"."processing_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_model_run_id_model_runs_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."model_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "difference_annotations" ADD CONSTRAINT "difference_annotations_utterance_id_utterances_id_fk" FOREIGN KEY ("utterance_id") REFERENCES "public"."utterances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "difference_annotations" ADD CONSTRAINT "difference_annotations_source_transcript_revision_id_transcript_revisions_id_fk" FOREIGN KEY ("source_transcript_revision_id") REFERENCES "public"."transcript_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "difference_annotations" ADD CONSTRAINT "difference_annotations_target_transcript_revision_id_transcript_revisions_id_fk" FOREIGN KEY ("target_transcript_revision_id") REFERENCES "public"."transcript_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_versions_study_version_uq" ON "consent_versions" USING btree ("study_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_task_followups_task_key_uq" ON "protocol_task_followups" USING btree ("protocol_task_id","followup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_tasks_version_key_uq" ON "protocol_tasks" USING btree ("protocol_version_id","task_key");--> statement-breakpoint
CREATE INDEX "protocol_tasks_version_order_idx" ON "protocol_tasks" USING btree ("protocol_version_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_versions_study_version_uq" ON "protocol_versions" USING btree ("study_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_items_version_key_uq" ON "questionnaire_items" USING btree ("questionnaire_version_id","item_key");--> statement-breakpoint
CREATE INDEX "questionnaire_items_version_order_idx" ON "questionnaire_items" USING btree ("questionnaire_version_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_versions_study_key_version_uq" ON "questionnaire_versions" USING btree ("study_id","key","version_number");--> statement-breakpoint
CREATE INDEX "rate_limit_hits_bucket_created_idx" ON "rate_limit_hits" USING btree ("bucket_key","created_at");--> statement-breakpoint
CREATE INDEX "media_assets_utterance_idx" ON "media_assets" USING btree ("utterance_id");--> statement-breakpoint
CREATE INDEX "media_assets_sha256_idx" ON "media_assets" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "media_assets_session_idx" ON "media_assets" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "media_assets_entity_idx" ON "media_assets" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_answers_response_item_uq" ON "questionnaire_answers" USING btree ("response_id","questionnaire_item_id");--> statement-breakpoint
CREATE INDEX "questionnaire_responses_session_idx" ON "questionnaire_responses" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_responses_session_version_uq" ON "questionnaire_responses" USING btree ("session_id","questionnaire_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_consents_session_uq" ON "session_consents" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_study_started_idx" ON "sessions" USING btree ("study_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_protocol_idx" ON "sessions" USING btree ("protocol_version_id");--> statement-breakpoint
CREATE INDEX "sessions_mode_status_idx" ON "sessions" USING btree ("mode","status");--> statement-breakpoint
CREATE UNIQUE INDEX "task_presentations_session_sequence_uq" ON "task_presentations" USING btree ("session_id","sequence_index");--> statement-breakpoint
CREATE UNIQUE INDEX "task_presentations_session_task_uq" ON "task_presentations" USING btree ("session_id","protocol_task_id");--> statement-breakpoint
CREATE INDEX "utterances_session_idx" ON "utterances" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "utterances_task_presentation_idx" ON "utterances" USING btree ("task_presentation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "utterances_presentation_turn_uq" ON "utterances" USING btree ("task_presentation_id","turn_index");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_prompt_versions_study_key_version_uq" ON "ai_prompt_versions" USING btree ("study_id","key","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_prompt_versions_one_active_uq" ON "ai_prompt_versions" USING btree ("study_id","key") WHERE "ai_prompt_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "export_jobs_study_created_idx" ON "export_jobs" USING btree ("study_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_available_idx" ON "jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "jobs_queued_available_idx" ON "jobs" USING btree ("available_at") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_batch_status_idx" ON "jobs" USING btree ("processing_batch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "model_configs_study_key_version_uq" ON "model_configs" USING btree ("study_id","key","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "model_configs_one_active_uq" ON "model_configs" USING btree ("study_id","key") WHERE "model_configs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "model_runs_stage_status_idx" ON "model_runs" USING btree ("stage","status");--> statement-breakpoint
CREATE INDEX "model_runs_batch_idx" ON "model_runs" USING btree ("processing_batch_id");--> statement-breakpoint
CREATE INDEX "model_runs_source_idx" ON "model_runs" USING btree ("source_entity_type","source_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_batches_study_name_uq" ON "processing_batches" USING btree ("study_id","name");--> statement-breakpoint
CREATE INDEX "syntheses_translation_idx" ON "syntheses" USING btree ("translation_id");--> statement-breakpoint
CREATE INDEX "syntheses_batch_idx" ON "syntheses" USING btree ("processing_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "syntheses_identity_uq" ON "syntheses" USING btree ("translation_id","condition_key","processing_batch_id","repetition_index");--> statement-breakpoint
CREATE UNIQUE INDEX "syntheses_model_run_uq" ON "syntheses" USING btree ("model_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_revisions_transcript_number_uq" ON "transcript_revisions" USING btree ("transcript_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_revisions_one_current_uq" ON "transcript_revisions" USING btree ("transcript_id") WHERE "transcript_revisions"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_utterance_type_uq" ON "transcripts" USING btree ("utterance_id","type");--> statement-breakpoint
CREATE INDEX "translations_source_revision_idx" ON "translations" USING btree ("source_transcript_revision_id");--> statement-breakpoint
CREATE INDEX "translations_batch_idx" ON "translations" USING btree ("processing_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "translations_identity_uq" ON "translations" USING btree ("source_transcript_revision_id","condition_key","processing_batch_id","repetition_index");--> statement-breakpoint
CREATE UNIQUE INDEX "translations_model_run_uq" ON "translations" USING btree ("model_run_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_entity_idx" ON "admin_audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "difference_annotations_utterance_idx" ON "difference_annotations" USING btree ("utterance_id");--> statement-breakpoint
CREATE INDEX "feature_annotations_target_idx" ON "feature_annotations" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "research_flags_entity_idx" ON "research_flags" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "research_notes_entity_idx" ON "research_notes" USING btree ("entity_type","entity_id");