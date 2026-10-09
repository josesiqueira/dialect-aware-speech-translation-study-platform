// Display labels of the Processing Runs page.
import { TRANSCRIPT_TYPE_LABELS, type BatchStatus, type TaskType, type TranscriptType } from "@dialect/domain";
import type { BadgeVariant } from "@/components/ui";
import type { BatchConfigLabel, ConfigSnapshot } from "./types";

export const BATCH_STATUS: Record<BatchStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: "Draft", variant: "incomplete" },
  queued: { label: "Queued", variant: "neutral" },
  running: { label: "Running", variant: "status" },
  completed: { label: "Completed", variant: "completed" },
  completed_with_errors: { label: "Completed with errors", variant: "warning" },
  cancelled: { label: "Cancelled", variant: "neutral" },
};

export const TRANSCRIPT_TYPE_NAMES: Record<TranscriptType, string> = {
  asr: "Automatic ASR transcript",
  asr_corrected: "ASR transcript with recognition errors corrected",
  human_dialect: "Human dialect transcript",
  normalized: "Normalized transcript",
};

export function transcriptTypeLabel(type: TranscriptType): string {
  return `${TRANSCRIPT_TYPE_LABELS[type]} (${TRANSCRIPT_TYPE_NAMES[type]})`;
}

export const TASK_TYPE_NAMES: Record<TaskType, string> = {
  controlled: "Controlled",
  semi_structured: "Semi-structured",
  free_speech: "Free speech",
};

// "translation_default v1"
export function configLabel(config: Pick<BatchConfigLabel | ConfigSnapshot, "key" | "versionNumber">): string {
  return `${config.key} v${config.versionNumber}`;
}

export function isActiveStatus(status: BatchStatus): boolean {
  return status === "queued" || status === "running";
}
