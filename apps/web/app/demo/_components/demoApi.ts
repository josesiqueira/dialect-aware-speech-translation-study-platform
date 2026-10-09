// Calls of the demo page to /api/demo/*. Every function throws ApiClientError
// with a message that can be shown.
import type { demoSchemas } from "@dialect/domain";
import { captureMetadataOf, recordingFileName } from "@/app/study/_lib/participantApi";
import type { RecordingCandidate } from "@/components/participant/recorder";
import { apiFetch, apiUpload } from "@/lib/client/api";
import type { RecorderFallbackInfo } from "@/lib/client/recorder";

export function fetchDemoSession(): Promise<demoSchemas.DemoSessionResponse> {
  return apiFetch<demoSchemas.DemoSessionResponse>("/api/demo/session", { redirectOnUnauthorized: false });
}

export function startDemoSession(): Promise<demoSchemas.StartDemoSessionResponse> {
  const body: demoSchemas.StartDemoSessionBody = {
    acknowledged: true,
    browserInfo: { userAgent: navigator.userAgent.slice(0, 500), language: navigator.language.slice(0, 50) },
  };
  return apiFetch<demoSchemas.StartDemoSessionResponse>("/api/demo/session", { method: "POST", body });
}

export function endDemoSession(): Promise<demoSchemas.EndDemoSessionResponse> {
  return apiFetch<demoSchemas.EndDemoSessionResponse>("/api/demo/session", { method: "DELETE" });
}

// The multipart body shared by the demo upload and the pipeline test upload.
export function recordingForm(candidate: RecordingCandidate, fallback: RecorderFallbackInfo | null): FormData {
  const form = new FormData();
  form.append("audio", candidate.blob, recordingFileName(candidate.mimeType));
  form.append("metadata", JSON.stringify(captureMetadataOf(candidate, fallback)));
  return form;
}

export function uploadDemoRecording(
  candidate: RecordingCandidate,
  fallback: RecorderFallbackInfo | null,
  onProgress: (fraction: number) => void,
): Promise<demoSchemas.DemoRecordingResponse> {
  return apiUpload<demoSchemas.DemoRecordingResponse>("/api/demo/recordings", recordingForm(candidate, fallback), {
    onProgress: (fraction) => onProgress(fraction),
  });
}

export async function runDemoStage(
  utteranceId: string,
  stage: demoSchemas.PipelineStageSelection,
  provider: demoSchemas.PipelineProviderMode,
): Promise<demoSchemas.DemoResult> {
  const body: demoSchemas.RunDemoRecordingBody = { stage, provider };
  const response = await apiFetch<demoSchemas.RunDemoRecordingResponse>(`/api/demo/recordings/${utteranceId}/run`, {
    method: "POST",
    body,
  });
  return response.result;
}

export function purgeLeftovers(): Promise<demoSchemas.PurgeLeftoversResponse> {
  return apiFetch<demoSchemas.PurgeLeftoversResponse>("/api/demo/purge-leftovers", {
    method: "POST",
    body: { confirm: true },
  });
}

export function demoMediaUrl(mediaAssetId: string): string {
  return `/api/demo/media/${mediaAssetId}`;
}
