// Browser calls to /api/admin/questionnaires.
import type { questionnaireSchemas as s } from "@dialect/domain";
import { apiFetch } from "@/lib/client/api";

const BASE = "/api/admin/questionnaires";
const version = (response: s.QuestionnaireVersionResponse) => response.version;

export const questionnaireApi = {
  list: () => apiFetch<s.ListQuestionnairesResponse>(BASE),
  get: (id: string) => apiFetch<s.QuestionnaireVersionResponse>(`${BASE}/${id}`).then(version),
  create: (body: s.CreateDraftBody) =>
    apiFetch<s.QuestionnaireVersionResponse>(BASE, { method: "POST", body }).then(version),
  save: (id: string, body: s.UpdateDraftBody) =>
    apiFetch<s.QuestionnaireVersionResponse>(`${BASE}/${id}`, { method: "PUT", body }).then(version),
  publish: (id: string) =>
    apiFetch<s.QuestionnaireVersionResponse>(`${BASE}/${id}/publish`, { method: "POST" }).then(version),
  clone: (id: string) =>
    apiFetch<s.QuestionnaireVersionResponse>(`${BASE}/${id}/clone`, { method: "POST" }).then(version),
  retire: (id: string) =>
    apiFetch<s.QuestionnaireVersionResponse>(`${BASE}/${id}/retire`, { method: "POST" }).then(version),
  remove: (id: string) => apiFetch<{ deleted: true; id: string }>(`${BASE}/${id}`, { method: "DELETE" }),
  diff: (id: string) => apiFetch<s.QuestionnaireDiffResponse>(`${BASE}/${id}/diff`).then((response) => response.diff),
};

export function errorMessage(error: unknown): string {
  const details = (error as { details?: { problems?: unknown } } | null)?.details;
  const problems = Array.isArray(details?.problems) ? ` ${details.problems.join(" ")}` : "";
  return error instanceof Error ? `${error.message}${problems}` : "The request failed.";
}
