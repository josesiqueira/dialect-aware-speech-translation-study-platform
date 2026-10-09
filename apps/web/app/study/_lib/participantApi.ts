// The calls of the participant pages to /api/study/*, one function per endpoint
// of docs/PARTICIPANT-API.md. The session is the HttpOnly cookie: no function
// takes or sends a session id. Failures throw ApiClientError.
import type { QuestionnaireKey, sessionSchemas } from "@dialect/domain";
import { apiFetch, apiUpload, isApiClientError, type ApiUploadOptions } from "@/lib/client/api";
import type { RecordingCandidate } from "@/components/participant/recorder/recorderMachine";
import type { RecorderFallbackInfo } from "@/lib/client/recorder";

type StateResponse = sessionSchemas.StateResponse;

const post = <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST", body });

export const participantApi = {
  createSession: (body: sessionSchemas.CreateSessionBody) =>
    post<sessionSchemas.CreateSessionResponse>("/api/study/sessions", body),
  getSession: () => apiFetch<sessionSchemas.SessionResponse>("/api/study/session", { cache: "no-store" }),
  consent: (body: sessionSchemas.ConsentBody) => post<StateResponse>("/api/study/consent", body),
  micCheck: (body: sessionSchemas.MicCheckBody) => post<StateResponse>("/api/study/mic-check", body),
  acknowledgeInstructions: () => post<StateResponse>("/api/study/instructions"),
  startTask: (presentationId: string) =>
    post<StateResponse>(`/api/study/tasks/${encodeURIComponent(presentationId)}/start`),
  createUtterance: (body: sessionSchemas.CreateUtteranceBody) =>
    post<sessionSchemas.CreateUtteranceResponse>("/api/study/utterances", body),
  uploadAudio: (utteranceId: string, form: FormData, options: Pick<ApiUploadOptions, "onProgress" | "signal">) =>
    apiUpload<sessionSchemas.UploadAudioResponse>(
      `/api/study/utterances/${encodeURIComponent(utteranceId)}/audio`,
      form,
      options,
    ),
  deleteCandidate: (utteranceId: string) =>
    apiFetch<StateResponse>(`/api/study/utterances/${encodeURIComponent(utteranceId)}/audio`, { method: "DELETE" }),
  submitUtterance: (utteranceId: string, body: sessionSchemas.SubmitUtteranceBody) =>
    post<StateResponse>(`/api/study/utterances/${encodeURIComponent(utteranceId)}/submit`, body),
  skipTurn: (utteranceId: string) =>
    post<StateResponse>(`/api/study/utterances/${encodeURIComponent(utteranceId)}/skip`),
  submitQuestionnaire: (key: QuestionnaireKey, body: sessionSchemas.QuestionnaireBody) =>
    post<StateResponse>(`/api/study/questionnaires/${key}`, body),
  // The part after the questionnaires (docs/PARTICIPANT-API.md, "Output review").
  englishCheck: (body: sessionSchemas.EnglishCheckBody) => post<StateResponse>("/api/study/english-check", body),
  startReview: () => post<StateResponse>("/api/study/output-review/start"),
  answerReviewItem: (itemId: string, body: sessionSchemas.OutputReviewAnswerBody) =>
    post<StateResponse>(`/api/study/output-review/items/${encodeURIComponent(itemId)}/answer`, body),
  skipReview: () => post<StateResponse>("/api/study/output-review/skip"),
  setLocale: (body: sessionSchemas.SetLocaleBody) => post<StateResponse>("/api/study/session/locale", body),
  complete: () => post<StateResponse>("/api/study/session/complete"),
  withdraw: () => post<StateResponse>("/api/study/session/withdraw"),
};

/** Address of the play button of a review screen: the participant's own recording. Served only to the owning session. */
export function reviewAudioUrl(itemId: string, which: "source"): string {
  return `/api/study/output-review/items/${encodeURIComponent(itemId)}/audio/${which}`;
}

/** The error code of a failed call, or "UNEXPECTED" for anything that is not an API error. */
export function errorCodeOf(error: unknown): string {
  return isApiClientError(error) ? error.code : "UNEXPECTED";
}

/**
 * The text set by the researchers for maintenance mode, when the failure is a
 * STUDY_CLOSED answer with that reason. Null for every other failure: other
 * server messages are not shown, the page uses its own dictionary text.
 */
export function maintenanceMessageOf(error: unknown): string | null {
  if (!isApiClientError(error) || error.code !== "STUDY_CLOSED") return null;
  const reason = (error.details as { reason?: unknown } | null | undefined)?.reason;
  return reason === "maintenance" && error.message ? error.message : null;
}

/** Item problems of a refused questionnaire (details.issues of a VALIDATION_ERROR). */
export function questionnaireIssuesOf(error: unknown): Array<{ itemKey: string; code: string }> {
  if (!isApiClientError(error) || error.code !== "VALIDATION_ERROR") return [];
  const issues = (error.details as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  const result: Array<{ itemKey: string; code: string }> = [];
  for (const issue of issues as Array<{ path?: unknown; code?: unknown }>) {
    if (typeof issue?.path === "string") {
      result.push({ itemKey: issue.path, code: typeof issue.code === "string" ? issue.code : "invalid" });
    }
  }
  return result;
}

// The limits of the request schemas in packages/domain/src/validators/sessions.ts.
const MAX_JSON_CHARACTERS = 4000;

function boundedJson<T>(value: T): T | undefined {
  try {
    return JSON.stringify(value).length <= MAX_JSON_CHARACTERS ? value : undefined;
  } catch {
    return undefined;
  }
}

function boundedMismatches(candidate: Pick<RecordingCandidate, "constraintMismatches">) {
  if (candidate.constraintMismatches.length === 0) return undefined;
  const list = candidate.constraintMismatches.slice(0, 20).map((mismatch) => ({
    constraint: String(mismatch.constraint).slice(0, 100),
    kind: mismatch.kind,
    requested: mismatch.requested,
    actual: mismatch.actual,
  }));
  return boundedJson(list) ?? list.map(({ constraint, kind }) => ({ constraint, kind }));
}

/** What the browser reports about itself. No address, no identifier (spec 6.2, 153). */
export function browserInfo(): sessionSchemas.BrowserInfoInput {
  return {
    userAgent: navigator.userAgent.slice(0, 500),
    language: navigator.language.slice(0, 35),
  };
}

/** The "metadata" part of the upload: every fact the recorder produced about the recording. */
export function captureMetadataOf(
  candidate: RecordingCandidate,
  fallback: RecorderFallbackInfo | null,
): sessionSchemas.CaptureMetadata {
  const finite = (value: number | null) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const metadata: sessionSchemas.CaptureMetadata = {
    captureMethod: candidate.captureMethod,
    requestedConstraints: boundedJson(candidate.requestedConstraints),
    actualTrackSettings: boundedJson(candidate.actualTrackSettings),
    audioContextSampleRate: finite(candidate.audioContextSampleRate),
    userAgent: navigator.userAgent.slice(0, 500),
    declaredDurationMs: finite(candidate.durationMs),
    declaredSampleRateHz: finite(candidate.sampleRateHz),
    declaredChannels: finite(candidate.channels),
    declaredBitDepth: finite(candidate.bitDepth),
    deviceLabel: candidate.deviceLabel ? candidate.deviceLabel.slice(0, 200) : undefined,
    constraintMismatches: boundedMismatches(candidate),
    fallbackReason: fallback?.reason,
    fallbackDetail: fallback?.detail ? fallback.detail.slice(0, 500) : undefined,
    inputChannelCount: finite(candidate.inputChannelCount),
    clippedSampleCount: finite(candidate.clippedSampleCount),
    peak: finite(candidate.peak),
    stoppedBy: candidate.stoppedBy,
  };
  // JSON.stringify drops the undefined fields, so only reported facts are sent.
  return metadata;
}

/** File name for the "audio" part. The server decides the real format from the bytes. */
export function recordingFileName(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type.includes("wav")) return "recording.wav";
  if (type.includes("webm")) return "recording.webm";
  if (type.includes("ogg")) return "recording.ogg";
  if (type.includes("mp4")) return "recording.m4a";
  return "recording";
}
