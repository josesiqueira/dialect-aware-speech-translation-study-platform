// Calls to the Processing Runs API (spec 60). Every function throws
// ApiClientError with a message that can be shown to the researcher.
import type { JobStatus, processingSchemas } from "@dialect/domain";
import { apiFetch } from "@/lib/client/api";
import type { BatchDetail, BatchJobList, BatchList, BatchPreview } from "./types";

const BASE = "/api/admin/processing";

export async function fetchBatches(page: number): Promise<BatchList> {
  return apiFetch<BatchList>(`${BASE}?page=${page}`);
}

export async function fetchBatch(id: string): Promise<BatchDetail> {
  return (await apiFetch<{ batch: BatchDetail }>(`${BASE}/${id}`)).batch;
}

export async function previewBatch(body: processingSchemas.PreviewBatchInput): Promise<BatchPreview> {
  return (await apiFetch<{ preview: BatchPreview }>(`${BASE}/preview`, { method: "POST", body })).preview;
}

export async function createBatch(body: processingSchemas.CreateBatchInput): Promise<BatchDetail> {
  return (await apiFetch<{ batch: BatchDetail }>(BASE, { method: "POST", body })).batch;
}

export async function startBatch(id: string): Promise<BatchDetail> {
  return (await apiFetch<{ batch: BatchDetail }>(`${BASE}/${id}/start`, { method: "POST" })).batch;
}

export async function cancelBatch(id: string): Promise<BatchDetail> {
  return (await apiFetch<{ batch: BatchDetail }>(`${BASE}/${id}/cancel`, { method: "POST" })).batch;
}

export async function retryFailedJobs(id: string): Promise<{ retried: number; batch: BatchDetail }> {
  return apiFetch<{ retried: number; batch: BatchDetail }>(`${BASE}/${id}/retry-failed`, { method: "POST" });
}

export async function fetchBatchJobs(id: string, status: JobStatus | null, page: number): Promise<BatchJobList> {
  const query = new URLSearchParams({ page: String(page) });
  if (status) query.set("status", status);
  return apiFetch<BatchJobList>(`${BASE}/${id}/jobs?${query.toString()}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The request failed. Try again.";
}
