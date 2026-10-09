// Calls to the AI configuration API (spec 60). Every function throws
// ApiClientError with a message that can be shown to the researcher.
import type { aiConfigSchemas } from "@dialect/domain";
import { apiFetch } from "@/lib/client/api";
import type { ConfigDiff, ModelConfig, PromptDiff, PromptVersion, ProviderStatus } from "./types";

// "prompts" or "configs": the two kinds share the same member routes.
export type Kind = "prompts" | "configs";

const base = (kind: Kind) => `/api/admin/ai/${kind}`;

export async function fetchPrompts(): Promise<PromptVersion[]> {
  return (await apiFetch<{ prompts: PromptVersion[] }>(base("prompts"))).prompts;
}

export async function fetchConfigs(): Promise<{ configs: ModelConfig[]; providers: ProviderStatus[] }> {
  return apiFetch<{ configs: ModelConfig[]; providers: ProviderStatus[] }>(base("configs"));
}

export async function createPrompt(body: aiConfigSchemas.CreatePromptBody): Promise<PromptVersion> {
  return (await apiFetch<{ prompt: PromptVersion }>(base("prompts"), { method: "POST", body })).prompt;
}

export async function updatePrompt(id: string, body: aiConfigSchemas.UpdatePromptBody): Promise<PromptVersion> {
  return (await apiFetch<{ prompt: PromptVersion }>(`${base("prompts")}/${id}`, { method: "PUT", body })).prompt;
}

export async function createConfig(body: aiConfigSchemas.CreateConfigBody): Promise<void> {
  await apiFetch(base("configs"), { method: "POST", body });
}

export async function updateConfig(id: string, body: aiConfigSchemas.UpdateConfigBody): Promise<void> {
  await apiFetch(`${base("configs")}/${id}`, { method: "PUT", body });
}

export async function cloneVersion(kind: Kind, id: string, options?: { useActivePrompt?: boolean }): Promise<void> {
  await apiFetch(`${base(kind)}/${id}/clone`, { method: "POST", body: options ?? {} });
}

export async function activateVersion(kind: Kind, id: string): Promise<void> {
  await apiFetch(`${base(kind)}/${id}/activate`, { method: "POST" });
}

export async function retireVersion(kind: Kind, id: string): Promise<void> {
  await apiFetch(`${base(kind)}/${id}/retire`, { method: "POST" });
}

export async function deleteDraft(kind: Kind, id: string): Promise<void> {
  await apiFetch(`${base(kind)}/${id}`, { method: "DELETE" });
}

export async function compareVersions(kind: "prompts", a: string, b: string): Promise<PromptDiff>;
export async function compareVersions(kind: "configs", a: string, b: string): Promise<ConfigDiff>;
export async function compareVersions(kind: Kind, a: string, b: string): Promise<PromptDiff | ConfigDiff>;
export async function compareVersions(kind: Kind, a: string, b: string): Promise<PromptDiff | ConfigDiff> {
  const query = new URLSearchParams({ a, b });
  return (await apiFetch<{ diff: PromptDiff | ConfigDiff }>(`${base(kind)}/compare?${query}`)).diff;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The request failed.";
}
