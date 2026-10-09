// Calls of the Review & Transcription page to its API routes.
import type { transcriptSchemas } from "@dialect/domain";
import { apiFetch } from "@/lib/client/api";

type HumanTranscriptType = transcriptSchemas.HumanTranscriptType;

const utterancePath = (utteranceId: string) => `/api/admin/utterances/${encodeURIComponent(utteranceId)}`;
const transcriptPath = (transcriptId: string) => `/api/admin/transcripts/${encodeURIComponent(transcriptId)}`;

// The stored source recording, streamed with HTTP Range support (corpus endpoint).
export const mediaUrl = (mediaAssetId: string) => `/api/admin/media/${encodeURIComponent(mediaAssetId)}`;

export const reviewApi = {
  queue: (query: URLSearchParams, signal?: AbortSignal) =>
    apiFetch<transcriptSchemas.ReviewQueueResponse>(`/api/admin/review/queue?${query.toString()}`, { signal }),

  utterance: (utteranceId: string, signal?: AbortSignal) =>
    apiFetch<transcriptSchemas.UtteranceForReview>(utterancePath(utteranceId), { signal }),

  saveRevision: (utteranceId: string, type: HumanTranscriptType, body: transcriptSchemas.SaveRevisionBody) =>
    apiFetch<transcriptSchemas.SaveRevisionResponse>(`${utterancePath(utteranceId)}/transcripts/${type}/revisions`, {
      method: "POST",
      body,
    }),

  verify: (transcriptId: string, body: transcriptSchemas.VerifyTranscriptBody) =>
    apiFetch<transcriptSchemas.VerifyTranscriptResponse>(`${transcriptPath(transcriptId)}/verify`, {
      method: "POST",
      body,
    }),

  setStatus: (transcriptId: string, body: transcriptSchemas.SetTranscriptStatusBody) =>
    apiFetch<transcriptSchemas.SetTranscriptStatusResponse>(`${transcriptPath(transcriptId)}/status`, {
      method: "POST",
      body,
    }),

  history: (transcriptId: string, signal?: AbortSignal) =>
    apiFetch<transcriptSchemas.TranscriptHistoryResponse>(`${transcriptPath(transcriptId)}/history`, { signal }),

  saveAnnotation: (utteranceId: string, body: transcriptSchemas.DifferenceAnnotationBody) =>
    apiFetch<transcriptSchemas.SaveDifferenceAnnotationResponse>(`${utterancePath(utteranceId)}/annotations`, {
      method: "POST",
      body,
    }),

  addFlag: (utteranceId: string, body: transcriptSchemas.AddFlagBody) =>
    apiFetch<transcriptSchemas.AddFlagResponse>(`${utterancePath(utteranceId)}/flags`, { method: "POST", body }),

  resolveFlag: (flagId: string, annotatorLabel?: string) =>
    apiFetch<transcriptSchemas.ResolveFlagResponse>(`/api/admin/review/flags/${encodeURIComponent(flagId)}/resolve`, {
      method: "POST",
      body: annotatorLabel ? { annotatorLabel } : {},
    }),

  addNote: (utteranceId: string, body: transcriptSchemas.AddNoteBody) =>
    apiFetch<transcriptSchemas.AddNoteResponse>(`${utterancePath(utteranceId)}/notes`, { method: "POST", body }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The request failed. Try again.";
}
