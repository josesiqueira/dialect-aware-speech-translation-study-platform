// Calls to the protocol and consent API. Every change to a draft sends the
// updated_at value the editor holds, so a save from a stale window is refused.
import type { protocolSchemas } from "@dialect/domain";
import { apiFetch, isApiClientError } from "@/lib/client/api";
import type {
  ConsentVersion,
  Overview,
  ProtocolDetail,
  ProtocolDiff,
  ProtocolValidation,
  PublishResult,
} from "./types";

const BASE = "/api/admin/protocols";
const CONSENTS = "/api/admin/consents";

type Stamp = string; // protocol.updatedAt as loaded

export const fetchOverview = () => apiFetch<Overview>(BASE);
export const fetchProtocol = (id: string) => apiFetch<ProtocolDetail>(`${BASE}/${id}`);
export const createDraft = (name: string) => apiFetch<ProtocolDetail>(BASE, { method: "POST", body: { name } });
export const cloneProtocol = (id: string) => apiFetch<ProtocolDetail>(`${BASE}/${id}/clone`, { method: "POST" });
export const deleteDraft = (id: string) => apiFetch<{ deleted: true }>(`${BASE}/${id}`, { method: "DELETE" });
export const retireProtocol = (id: string) => apiFetch<ProtocolDetail>(`${BASE}/${id}/retire`, { method: "POST" });
export const publishProtocol = (id: string) => apiFetch<PublishResult>(`${BASE}/${id}/publish`, { method: "POST" });
export const validateProtocol = (id: string) => apiFetch<ProtocolValidation>(`${BASE}/${id}/validate`);
export const fetchDiff = (id: string, against?: string | null) =>
  apiFetch<ProtocolDiff>(`${BASE}/${id}/diff${against ? `?against=${encodeURIComponent(against)}` : ""}`);

export const updateDraft = (id: string, stamp: Stamp, changes: protocolSchemas.ProtocolDraftChanges) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}`, { method: "PUT", body: { ...changes, expectedUpdatedAt: stamp } });

export const addTask = (id: string, stamp: Stamp, input: protocolSchemas.TaskInput) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}/tasks`, { method: "POST", body: { ...input, expectedUpdatedAt: stamp } });
export const updateTask = (id: string, taskId: string, stamp: Stamp, changes: protocolSchemas.TaskChanges) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}/tasks/${taskId}`, {
    method: "PUT",
    body: { ...changes, expectedUpdatedAt: stamp },
  });
export const deleteTask = (id: string, taskId: string, stamp: Stamp) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}/tasks/${taskId}?expectedUpdatedAt=${encodeURIComponent(stamp)}`, {
    method: "DELETE",
  });
export const cloneTask = (id: string, taskId: string, stamp: Stamp) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}/tasks/${taskId}/clone`, {
    method: "POST",
    body: { expectedUpdatedAt: stamp },
  });
export const moveTask = (id: string, taskId: string, stamp: Stamp, direction: protocolSchemas.MoveDirection) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}/tasks/${taskId}/move`, {
    method: "POST",
    body: { direction, expectedUpdatedAt: stamp },
  });
export const setTaskEnabled = (id: string, taskId: string, stamp: Stamp, enabled: boolean) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}/tasks/${taskId}/enabled`, {
    method: "POST",
    body: { enabled, expectedUpdatedAt: stamp },
  });

export const addFollowup = (id: string, taskId: string, stamp: Stamp, input: protocolSchemas.FollowupInput) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}/tasks/${taskId}/followups`, {
    method: "POST",
    body: { ...input, expectedUpdatedAt: stamp },
  });
export const updateFollowup = (
  id: string,
  taskId: string,
  followupId: string,
  stamp: Stamp,
  changes: protocolSchemas.FollowupChanges,
) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}/tasks/${taskId}/followups/${followupId}`, {
    method: "PUT",
    body: { ...changes, expectedUpdatedAt: stamp },
  });
export const deleteFollowup = (id: string, taskId: string, followupId: string, stamp: Stamp) =>
  apiFetch<ProtocolDetail>(
    `${BASE}/${id}/tasks/${taskId}/followups/${followupId}?expectedUpdatedAt=${encodeURIComponent(stamp)}`,
    { method: "DELETE" },
  );
export const moveFollowup = (
  id: string,
  taskId: string,
  followupId: string,
  stamp: Stamp,
  direction: protocolSchemas.MoveDirection,
) =>
  apiFetch<ProtocolDetail>(`${BASE}/${id}/tasks/${taskId}/followups/${followupId}/move`, {
    method: "POST",
    body: { direction, expectedUpdatedAt: stamp },
  });

export const fetchConsents = () => apiFetch<{ studyId: string; consents: ConsentVersion[] }>(CONSENTS);
export const createConsent = (body: protocolSchemas.CreateConsentDraftBody) =>
  apiFetch<ConsentVersion>(CONSENTS, { method: "POST", body });
export const updateConsent = (id: string, changes: protocolSchemas.ConsentDraftChanges) =>
  apiFetch<ConsentVersion>(`${CONSENTS}/${id}`, { method: "PUT", body: changes });
export const cloneConsent = (id: string) => apiFetch<ConsentVersion>(`${CONSENTS}/${id}/clone`, { method: "POST" });
export const publishConsent = (id: string) =>
  apiFetch<ConsentVersion>(`${CONSENTS}/${id}/publish`, { method: "POST" });
export const deleteConsent = (id: string) => apiFetch<{ deleted: true }>(`${CONSENTS}/${id}`, { method: "DELETE" });

// A message that can be shown next to the control that failed.
export function errorMessage(error: unknown): string {
  if (isApiClientError(error)) {
    const issues = (error.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues;
    if (error.code === "VALIDATION_ERROR" && issues && issues.length > 0) {
      return issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join(" ");
    }
    return error.message;
  }
  return "Something went wrong. Please try again.";
}
