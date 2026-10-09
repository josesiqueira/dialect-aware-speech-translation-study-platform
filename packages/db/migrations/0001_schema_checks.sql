CREATE INDEX "utterances_accepted_media_idx" ON "utterances" USING btree ("accepted_media_asset_id");--> statement-breakpoint
CREATE INDEX "syntheses_media_asset_idx" ON "syntheses" USING btree ("media_asset_id");--> statement-breakpoint
ALTER TABLE "consent_versions" ADD CONSTRAINT "consent_versions_version_number_ck" CHECK ("consent_versions"."version_number" >= 1);--> statement-breakpoint
ALTER TABLE "protocol_tasks" ADD CONSTRAINT "protocol_tasks_durations_ck" CHECK (("protocol_tasks"."min_duration_seconds" IS NULL OR "protocol_tasks"."min_duration_seconds" >= 0)
        AND ("protocol_tasks"."suggested_duration_seconds" IS NULL OR "protocol_tasks"."suggested_duration_seconds" >= 0)
        AND ("protocol_tasks"."max_duration_seconds" IS NULL OR "protocol_tasks"."max_duration_seconds" > 0)
        AND ("protocol_tasks"."min_duration_seconds" IS NULL OR "protocol_tasks"."max_duration_seconds" IS NULL
          OR "protocol_tasks"."min_duration_seconds" <= "protocol_tasks"."max_duration_seconds"));--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_version_number_ck" CHECK ("protocol_versions"."version_number" >= 1);--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_published_at_ck" CHECK ("protocol_versions"."status" = 'draft' OR "protocol_versions"."published_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_version_number_ck" CHECK ("questionnaire_versions"."version_number" >= 1);--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD CONSTRAINT "questionnaire_versions_published_at_ck" CHECK ("questionnaire_versions"."status" = 'draft' OR "questionnaire_versions"."published_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_sha256_ck" CHECK ("media_assets"."sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_size_bytes_ck" CHECK ("media_assets"."size_bytes" >= 0);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_duration_ms_ck" CHECK ("media_assets"."duration_ms" IS NULL OR "media_assets"."duration_ms" >= 0);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_audio_format_ck" CHECK (("media_assets"."sample_rate_hz" IS NULL OR "media_assets"."sample_rate_hz" > 0)
        AND ("media_assets"."channels" IS NULL OR "media_assets"."channels" > 0)
        AND ("media_assets"."bit_depth" IS NULL OR "media_assets"."bit_depth" > 0));--> statement-breakpoint
ALTER TABLE "task_presentations" ADD CONSTRAINT "task_presentations_sequence_index_ck" CHECK ("task_presentations"."sequence_index" >= 0);--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_attempt_count_ck" CHECK ("utterances"."attempt_count" >= 1);--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_turn_index_ck" CHECK ("utterances"."turn_index" >= 0);--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_duration_ms_ck" CHECK ("utterances"."duration_ms" IS NULL OR "utterances"."duration_ms" >= 0);--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_submitted_has_media_ck" CHECK ("utterances"."status" <> 'submitted'
        OR ("utterances"."accepted_media_asset_id" IS NOT NULL AND "utterances"."submitted_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ai_prompt_versions" ADD CONSTRAINT "ai_prompt_versions_version_number_ck" CHECK ("ai_prompt_versions"."version_number" >= 1);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attempts_ck" CHECK ("jobs"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_max_attempts_ck" CHECK ("jobs"."max_attempts" >= 1);--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_version_number_ck" CHECK ("model_configs"."version_number" >= 1);--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_attempt_number_ck" CHECK ("model_runs"."attempt_number" >= 1);--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_latency_ms_ck" CHECK ("model_runs"."latency_ms" IS NULL OR "model_runs"."latency_ms" >= 0);--> statement-breakpoint
ALTER TABLE "syntheses" ADD CONSTRAINT "syntheses_repetition_index_ck" CHECK ("syntheses"."repetition_index" >= 0);--> statement-breakpoint
ALTER TABLE "transcript_revisions" ADD CONSTRAINT "transcript_revisions_revision_number_ck" CHECK ("transcript_revisions"."revision_number" >= 1);--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_repetition_index_ck" CHECK ("translations"."repetition_index" >= 0);--> statement-breakpoint
ALTER TABLE "difference_annotations" ADD CONSTRAINT "difference_annotations_spans_ck" CHECK (("difference_annotations"."source_start" IS NULL OR "difference_annotations"."source_start" >= 0)
        AND ("difference_annotations"."source_end" IS NULL OR "difference_annotations"."source_start" IS NULL OR "difference_annotations"."source_end" >= "difference_annotations"."source_start")
        AND ("difference_annotations"."target_start" IS NULL OR "difference_annotations"."target_start" >= 0)
        AND ("difference_annotations"."target_end" IS NULL OR "difference_annotations"."target_start" IS NULL OR "difference_annotations"."target_end" >= "difference_annotations"."target_start"));--> statement-breakpoint
ALTER TABLE "feature_annotations" ADD CONSTRAINT "feature_annotations_confidence_ck" CHECK ("feature_annotations"."confidence" IS NULL OR ("feature_annotations"."confidence" >= 0 AND "feature_annotations"."confidence" <= 1));