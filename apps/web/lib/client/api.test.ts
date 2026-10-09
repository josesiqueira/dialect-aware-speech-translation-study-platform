// Runs in the server (node) test configuration: fetch, window and XMLHttpRequest are replaced by fakes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, apiFetch, apiUpload } from "./api";

function respondWith(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubWindow(pathname: string, search = "") {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { pathname, search, assign } });
  return assign;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("sends a plain object as JSON and returns the parsed response", async () => {
    const fetchMock = respondWith(200, { ok: true });
    const result = await apiFetch<{ ok: boolean }>("/api/admin/login", { method: "POST", body: { password: "x" } });
    expect(result).toEqual({ ok: true });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/admin/login");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"password":"x"}');
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("passes FormData and Blob bodies through without a JSON content type", async () => {
    const fetchMock = respondWith(200, {});
    const form = new FormData();
    form.set("file", new Blob(["abc"], { type: "audio/wav" }), "a.wav");
    await apiFetch("/api/study/utterances/1/audio", { method: "POST", body: form });
    const blob = new Blob(["abc"], { type: "audio/wav" });
    await apiFetch("/api/study/utterances/1/audio", { method: "POST", body: blob });
    expect(fetchMock.mock.calls[0][1].body).toBe(form);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has("content-type")).toBe(false);
    expect(fetchMock.mock.calls[1][1].body).toBe(blob);
  });

  it("throws ApiClientError built from the standard error body", async () => {
    respondWith(409, { error: { code: "IMMUTABLE_RECORD", message: "Published.", details: { reason: "x" } } }, { "x-request-id": "req-9" });
    const error = await apiFetch("/api/study/session").catch((e) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code: "IMMUTABLE_RECORD", message: "Published.", status: 409, details: { reason: "x" }, requestId: "req-9" });
  });

  it("falls back to INTERNAL_ERROR for a non-standard error body and NETWORK_ERROR without a response", async () => {
    respondWith(502);
    expect(await apiFetch("/api/x").catch((e) => e)).toMatchObject({ code: "INTERNAL_ERROR", status: 502 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await apiFetch("/api/x").catch((e) => e)).toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });

  it("returns undefined for an empty success body", async () => {
    respondWith(204);
    expect(await apiFetch("/api/x")).toBeUndefined();
  });

  it("redirects to the admin login page on 401 from an admin route only", async () => {
    const unauthorized = { error: { code: "UNAUTHORIZED", message: "Admin sign-in is required." } };
    let assign = stubWindow("/admin/sessions", "?page=2");
    respondWith(401, unauthorized);
    await expect(apiFetch("/api/admin/sessions")).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    expect(assign).toHaveBeenCalledWith("/admin/login?next=%2Fadmin%2Fsessions%3Fpage%3D2");

    // A wrong password on the login form must not navigate.
    assign = stubWindow("/admin/login");
    await expect(apiFetch("/api/admin/login", { method: "POST", body: { password: "x" } })).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();

    // Participant routes never redirect to the admin login.
    assign = stubWindow("/study");
    respondWith(401, { error: { code: "SESSION_EXPIRED", message: "Expired." } });
    await expect(apiFetch("/api/study/session")).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(assign).not.toHaveBeenCalled();

    assign = stubWindow("/admin/sessions");
    respondWith(401, unauthorized);
    await expect(apiFetch("/api/admin/sessions", { redirectOnUnauthorized: false })).rejects.toBeInstanceOf(ApiClientError);
    expect(assign).not.toHaveBeenCalled();
  });
});

class FakeXhr {
  static last: FakeXhr;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  withCredentials = false;
  requestHeaders: Record<string, string> = {};
  method = "";
  url = "";
  sent: unknown;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }
  getResponseHeader() {
    return null;
  }
  send(body: unknown) {
    this.sent = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe("apiUpload", () => {
  it("reports progress and resolves with the parsed response", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    const blob = new Blob(["0123456789"], { type: "audio/wav" });
    const promise = apiUpload<{ mediaId: string }>("/api/study/utterances/1/audio", blob, { onProgress: (fraction) => progress.push(fraction) });
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe("POST");
    expect(xhr.requestHeaders["Content-Type"]).toBe("audio/wav");
    expect(xhr.sent).toBe(blob);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 });
    xhr.respond(200, { mediaId: "m-1" });
    expect(await promise).toEqual({ mediaId: "m-1" });
    expect(progress).toEqual([0.5, 1]);
  });

  it("rejects with the standard error, on network failure and on abort", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const blob = new Blob(["x"]);

    const failed = apiUpload("/api/study/utterances/1/audio", blob);
    FakeXhr.last.respond(413, { error: { code: "PAYLOAD_TOO_LARGE", message: "Too large." } });
    await expect(failed).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });

    const offline = apiUpload("/api/study/utterances/1/audio", blob);
    FakeXhr.last.onerror?.();
    await expect(offline).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });

    const controller = new AbortController();
    const aborted = apiUpload("/api/study/utterances/1/audio", blob, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });

    const already = new AbortController();
    already.abort();
    await expect(apiUpload("/api/x", blob, { signal: already.signal })).rejects.toMatchObject({ code: "ABORTED" });
  });
});
