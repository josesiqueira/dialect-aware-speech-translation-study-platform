// Browser helper for calling the app's own API. No secrets live here: the browser
// authenticates with HttpOnly cookies that scripts cannot read.
//
// Usage:
//   const data = await apiFetch<{ sessions: SessionRow[] }>("/api/admin/sessions?page=2");
//   await apiFetch("/api/admin/login", { method: "POST", body: { password } });
//   await apiUpload(`/api/study/utterances/${id}/audio`, wavBlob, { onProgress, signal });
//
// Failures throw ApiClientError with the `code` from the standard error body
// { error: { code, message, details? } }, so callers can branch on error.code.
import type { ErrorCode } from "@dialect/domain";

// NETWORK_ERROR: the request did not reach the server. ABORTED: cancelled through the signal.
export type ApiClientErrorCode = ErrorCode | "NETWORK_ERROR" | "ABORTED";

export class ApiClientError extends Error {
  readonly code: ApiClientErrorCode;
  // HTTP status, or 0 when there was no response.
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(code: ApiClientErrorCode, message: string, status: number, details?: unknown, requestId?: string) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  if (value instanceof ApiClientError) return true;
  // Also an error of the same shape made by another copy of the class.
  return (
    value instanceof Error &&
    value.name === "ApiClientError" &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { status?: unknown }).status === "number"
  );
}

export type ApiFetchInit = Omit<RequestInit, "body"> & {
  // A plain object or array is sent as JSON. FormData, Blob, URLSearchParams,
  // ArrayBuffer and string bodies are sent unchanged.
  body?: unknown;
  // Set false to handle a 401 from an admin route yourself. Default true.
  redirectOnUnauthorized?: boolean;
};

function isPassThroughBody(body: unknown): body is BodyInit {
  return (
    typeof body === "string" ||
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

function pathnameOf(path: string): string {
  return path.split(/[?#]/)[0];
}

// An expired admin session: send the researcher to the login page and come back afterwards.
function redirectToAdminLogin(path: string): void {
  if (typeof window === "undefined") return;
  const pathname = pathnameOf(path);
  if (!pathname.startsWith("/api/admin/") || pathname === "/api/admin/login") return;
  if (window.location.pathname === "/admin/login") return;
  const current = `${window.location.pathname}${window.location.search}`;
  // A full page load on purpose: it discards all client state of the expired session,
  // and this helper runs outside React, where the router is not available.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/admin/login?next=${encodeURIComponent(current)}`);
}

function errorFromBody(status: number, body: unknown, requestId?: string): ApiClientError {
  const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return new ApiClientError(error.code as ErrorCode, error.message, status, error.details, requestId);
  }
  return new ApiClientError("INTERNAL_ERROR", `The request failed (HTTP ${status}).`, status, undefined, requestId);
}

function parseJsonText(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// JSON request and response. Resolves with the parsed body (undefined for an empty body).
export async function apiFetch<T = unknown>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const { body, redirectOnUnauthorized = true, headers: initHeaders, ...rest } = init;
  const headers = new Headers(initHeaders);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  let requestBody: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (isPassThroughBody(body)) {
      requestBody = body;
    } else {
      requestBody = JSON.stringify(body);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
  }

  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...rest, headers, body: requestBody });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new ApiClientError("ABORTED", "The request was cancelled.", 0);
    }
    throw new ApiClientError("NETWORK_ERROR", "The server could not be reached. Check the connection and try again.", 0);
  }

  const requestId = response.headers.get("x-request-id") ?? undefined;
  const parsed = parseJsonText(await response.text());
  if (!response.ok) {
    if (response.status === 401 && redirectOnUnauthorized) redirectToAdminLogin(path);
    throw errorFromBody(response.status, parsed, requestId);
  }
  return parsed as T;
}

export type ApiUploadOptions = {
  // Called with a fraction between 0 and 1 while the body is being sent.
  onProgress?: (fraction: number, loadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  redirectOnUnauthorized?: boolean;
};

// Upload with progress. fetch() cannot report upload progress, so this uses
// XMLHttpRequest. The response is handled exactly like apiFetch.
export function apiUpload<T = unknown>(
  path: string,
  body: FormData | Blob,
  options: ApiUploadOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { onProgress, signal, method = "POST", headers = {}, redirectOnUnauthorized = true } = options;
    if (signal?.aborted) {
      reject(new ApiClientError("ABORTED", "The upload was cancelled.", 0));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = false; // same-origin requests send cookies anyway
    xhr.setRequestHeader("Accept", "application/json");
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    // A Blob is sent with its own type. FormData sets the multipart boundary itself.
    if (body instanceof Blob && body.type && !("Content-Type" in headers)) {
      xhr.setRequestHeader("Content-Type", body.type);
    }

    const onAbort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort);

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total, event.loaded, event.total);
      };
    }

    xhr.onload = () => {
      cleanup();
      const requestId = xhr.getResponseHeader("x-request-id") ?? undefined;
      const parsed = parseJsonText(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as T);
        return;
      }
      if (xhr.status === 401 && redirectOnUnauthorized) redirectToAdminLogin(path);
      reject(errorFromBody(xhr.status, parsed, requestId));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiClientError("NETWORK_ERROR", "The upload did not reach the server. Check the connection and try again.", 0));
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      cleanup();
      reject(new ApiClientError("ABORTED", "The upload was cancelled.", 0));
    };

    xhr.send(body);
  });
}
