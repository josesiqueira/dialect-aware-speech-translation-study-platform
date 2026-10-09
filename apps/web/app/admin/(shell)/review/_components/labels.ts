// Display texts of the Review & Transcription page.
import type { DifferenceCategory, FlagReasonCode, ReviewStatus, TaskType, TranscriptType } from "@dialect/domain";
import type { BadgeVariant } from "@/components/ui";

export const TRANSCRIPT_NAMES: Record<TranscriptType, string> = {
  asr: "ASR transcript",
  asr_corrected: "ASR corrected",
  human_dialect: "Human dialect-preserving",
  normalized: "Normalized Finnish",
};

// One line per editor that reminds the researcher what this transcript is (spec 16).
export const TRANSCRIPT_GUIDANCE: Record<Exclude<TranscriptType, "asr">, string> = {
  asr_corrected: "Correct recognition errors only. Leave the normalization made by the ASR system as it is.",
  human_dialect: "Transcribe from the audio. Keep dialect and other non-standard forms as they were spoken.",
  normalized: "Minimally normalized Finnish written from B. Keep the content and the discourse events; do not polish.",
};

export const STATUS_LABELS: Record<ReviewStatus, string> = {
  not_started: "not started",
  draft: "draft",
  needs_review: "needs review",
  verified: "verified",
};

export const STATUS_BADGE: Record<ReviewStatus, BadgeVariant> = {
  not_started: "incomplete",
  draft: "neutral",
  needs_review: "needs-review",
  verified: "verified",
};

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  controlled: "Controlled",
  semi_structured: "Semi-structured",
  free_speech: "Free speech",
};

export const DIFFERENCE_CATEGORY_LABELS: Record<DifferenceCategory, string> = {
  recognition_error: "Recognition error",
  normalization: "Normalization",
  omission: "Omission",
  addition: "Addition",
  segmentation: "Segmentation",
  punctuation_or_formatting: "Punctuation or formatting",
  uncertain: "Uncertain",
};

export const FLAG_REASON_LABELS: Record<FlagReasonCode, string> = {
  contains_third_party_identifier: "Contains third-party identifier",
  poor_audio: "Poor audio",
  asr_problem: "ASR problem",
  interesting_dialect_feature: "Interesting dialect feature",
  translation_problem: "Translation problem",
  tts_problem: "TTS problem",
  needs_expert_review: "Needs expert review",
  other: "Other",
};

export function flagReasonLabel(code: string | null): string {
  if (code === null) return "No reason given";
  return (FLAG_REASON_LABELS as Record<string, string>)[code] ?? code;
}

// "U-7cb1a2b3": the short form of an utterance id used in headings (spec 46).
export function shortUtteranceId(id: string): string {
  return `U-${id.slice(0, 8)}`;
}

// "WAV, 48 kHz, 16 bit, mono"
export function describeAudioFormat(media: {
  container: string | null;
  codec: string | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
}): string {
  const parts: string[] = [];
  const container = media.container ?? media.codec;
  if (container) parts.push(container.toUpperCase());
  if (media.sampleRateHz) parts.push(`${Number((media.sampleRateHz / 1000).toFixed(1))} kHz`);
  if (media.bitDepth) parts.push(`${media.bitDepth} bit`);
  if (media.channels) parts.push(media.channels === 1 ? "mono" : media.channels === 2 ? "stereo" : `${media.channels} channels`);
  return parts.join(", ");
}
