import { pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  ANNOTATION_SCOPES,
  BATCH_STATUSES,
  CONFIG_STATUSES,
  EXPORT_JOB_STATUSES,
  JOB_STATUSES,
  MEDIA_KINDS,
  MODEL_RUN_STAGES,
  MODEL_RUN_STATUSES,
  ORDER_MODES,
  OUTPUT_STATUSES,
  PRESENTATION_STATUSES,
  PROCESSING_STAGES,
  PUBLICATION_STATUSES,
  QUESTIONNAIRE_ITEM_TYPES,
  REVIEW_STATUSES,
  REVISION_AUTHOR_TYPES,
  SESSION_STATUSES,
  STUDY_MODES,
  STUDY_STATUSES,
  TASK_TYPES,
  TRANSCRIPT_TYPES,
  UTTERANCE_STATUSES,
} from "@dialect/domain";

// All timestamps are stored in UTC as timestamptz (spec section 101).
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const pk = () => uuid("id").primaryKey().defaultRandom();
export const createdAt = () => ts("created_at").notNull().defaultNow();
export const updatedAt = () => ts("updated_at").notNull().defaultNow();

export const studyModeEnum = pgEnum("study_mode", STUDY_MODES);
export const studyStatusEnum = pgEnum("study_status", STUDY_STATUSES);
export const taskTypeEnum = pgEnum("task_type", TASK_TYPES);
export const orderModeEnum = pgEnum("order_mode", ORDER_MODES);
export const publicationStatusEnum = pgEnum("publication_status", PUBLICATION_STATUSES);
export const configStatusEnum = pgEnum("config_status", CONFIG_STATUSES);
export const sessionStatusEnum = pgEnum("session_status", SESSION_STATUSES);
export const presentationStatusEnum = pgEnum("presentation_status", PRESENTATION_STATUSES);
export const utteranceStatusEnum = pgEnum("utterance_status", UTTERANCE_STATUSES);
export const mediaKindEnum = pgEnum("media_kind", MEDIA_KINDS);
export const transcriptTypeEnum = pgEnum("transcript_type", TRANSCRIPT_TYPES);
export const reviewStatusEnum = pgEnum("review_status", REVIEW_STATUSES);
export const revisionAuthorTypeEnum = pgEnum("revision_author_type", REVISION_AUTHOR_TYPES);
export const processingStageEnum = pgEnum("processing_stage", PROCESSING_STAGES);
export const modelRunStageEnum = pgEnum("model_run_stage", MODEL_RUN_STAGES);
export const modelRunStatusEnum = pgEnum("model_run_status", MODEL_RUN_STATUSES);
export const batchStatusEnum = pgEnum("batch_status", BATCH_STATUSES);
export const outputStatusEnum = pgEnum("output_status", OUTPUT_STATUSES);
export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);
export const exportJobStatusEnum = pgEnum("export_job_status", EXPORT_JOB_STATUSES);
export const questionnaireItemTypeEnum = pgEnum("questionnaire_item_type", QUESTIONNAIRE_ITEM_TYPES);
export const annotationScopeEnum = pgEnum("annotation_scope", ANNOTATION_SCOPES);
