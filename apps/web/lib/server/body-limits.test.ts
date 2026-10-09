// Request body limits (spec 67): JSON bodies are read through a counted stream
// with a small cap, and an upload is read once into one buffer.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAdminSession } from "./admin-auth";
import {
  ADMIN_JSON_BODY_LIMIT_BYTES,
  apiRoute,
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  jsonOk,
  parseJsonBody,
  readLimitedBody,
} from "./api";
import { multipartBoundary, parseMultipart } from "./multipart";
import { noParams, setupServerTestHarness } from "./test/database";
import { activeUploadCountForTests, withSingleUpload } from "./upload-guard";

setupServerTestHarness();
const URL_ = "http://localhost:3000/api/test";
const schema = z.object({ text: z.string() });

function jsonBodyOf(bytes: number): string {
  return JSON.stringify({ text: "x".repeat(Math.max(0, bytes - 11)) });
}

// A request whose body arrives in chunks without a Content-Length header, and
// that counts how many bytes the server pulled.
function streamed(totalBytes: number, chunkBytes = 16 * 1024): { request: Request; pulled: () => number } {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
  const request = new Request(URL_, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, pulled: () => sent };
}

describe("parseJsonBody size limit", () => {
  const publicRoute = apiRoute(async (request) => jsonOk(await parseJsonBody(request, schema)), { auth: "public" });
  const adminRoute = apiRoute(async (request) => jsonOk(await parseJsonBody(request, schema)), { auth: "admin" });
  const post = (body: string) =>
    new Request(URL_, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), origin: "http://localhost:3000" },
    });

  it("accepts a body up to 64 KB on a public route and refuses a larger one with 413", async () => {
    expect(DEFAULT_JSON_BODY_LIMIT_BYTES).toBe(64 * 1024);
    expect((await publicRoute(post(jsonBodyOf(DEFAULT_JSON_BODY_LIMIT_BYTES)), noParams)).status).toBe(200);
    const response = await publicRoute(post(jsonBodyOf(DEFAULT_JSON_BODY_LIMIT_BYTES + 1)), noParams);
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      details: { reason: "too_large", maxBytes: DEFAULT_JSON_BODY_LIMIT_BYTES },
    });
  });

  it("refuses by the announced Content-Length before reading anything", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const request = new Request(URL_, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "content-length": String(40 * 1024 * 1024) },
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readLimitedBody(request, DEFAULT_JSON_BODY_LIMIT_BYTES)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    // Nothing beyond what the stream buffered by itself was pulled.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("stops reading a 40 MB body without Content-Length shortly after the limit", async () => {
    const { request, pulled } = streamed(40 * 1024 * 1024);
    const response = await publicRoute(request, noParams);
    expect(response.status).toBe(413);
    expect(pulled()).toBeLessThan(DEFAULT_JSON_BODY_LIMIT_BYTES + 64 * 1024);
  });

  it("lets a route raise the limit for itself", async () => {
    const route = apiRoute(async (request) => jsonOk(await parseJsonBody(request, schema, { maxBytes: 256 * 1024 })), {
      auth: "public",
    });
    expect((await route(post(jsonBodyOf(200 * 1024)), noParams)).status).toBe(200);
    expect((await route(post(jsonBodyOf(300 * 1024)), noParams)).status).toBe(413);
  });

  it("allows 1 MB on an admin route and refuses more", async () => {
    await createAdminSession();
    expect((await adminRoute(post(jsonBodyOf(ADMIN_JSON_BODY_LIMIT_BYTES - 100)), noParams)).status).toBe(200);
    expect((await adminRoute(post(jsonBodyOf(ADMIN_JSON_BODY_LIMIT_BYTES + 100)), noParams)).status).toBe(413);
  });

  it("still answers 400 for a body that is not JSON, and for an empty body", async () => {
    expect((await publicRoute(post("{not json"), noParams)).status).toBe(400);
    expect((await publicRoute(new Request(URL_, { method: "POST" }), noParams)).status).toBe(400);
  });
});

describe("parseMultipart", () => {
  async function bodyOf(form: FormData): Promise<{ buffer: Buffer; contentType: string }> {
    const request = new Request(URL_, { method: "POST", body: form });
    return { buffer: Buffer.from(await request.arrayBuffer()), contentType: request.headers.get("content-type")! };
  }

  it("reads the parts that a browser FormData body contains, the file as a view of the body buffer", async () => {
    const audio = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255, 254, 0]);
    const form = new FormData();
    form.set("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "recording.wav");
    form.set("metadata", JSON.stringify({ captureMethod: "audio_worklet_pcm", note: "ääkköset" }));
    const { buffer, contentType } = await bodyOf(form);
    expect(multipartBoundary(contentType)).toBeTruthy();

    const parts = parseMultipart(buffer, contentType);
    const file = parts.files.get("audio")!;
    expect(file.type).toBe("audio/wav");
    expect(file.filename).toBe("recording.wav");
    expect(file.data.equals(audio)).toBe(true);
    // The same memory as the request body, not a copy.
    expect(file.data.buffer).toBe(buffer.buffer);
    expect(JSON.parse(parts.fields.get("metadata")!)).toEqual({ captureMethod: "audio_worklet_pcm", note: "ääkköset" });
  });

  it("keeps audio bytes that look like a boundary line of another form", async () => {
    const audio = Buffer.from("\r\n--not-the-boundary\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\n", "latin1");
    const form = new FormData();
    form.set("audio", new Blob([new Uint8Array(audio)]), "a.bin");
    const { buffer, contentType } = await bodyOf(form);
    expect(parseMultipart(buffer, contentType).files.get("audio")!.data.equals(audio)).toBe(true);
  });

  it("refuses a body that is not well formed", () => {
    const type = "multipart/form-data; boundary=abc";
    for (const text of ["", "no boundary here", "--abc\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nnever closed", "--abc\r\nX: y\r\n\r\nv\r\n--abc--"]) {
      expect(() => parseMultipart(Buffer.from(text), type), text).toThrowError(/could not be read/);
    }
    expect(() => parseMultipart(Buffer.from("x"), "application/json")).toThrowError(/multipart\/form-data/);
  });
});

describe("withSingleUpload", () => {
  it("runs one upload per key at a time and refuses a second one with 409", async () => {
    let release!: () => void;
    const first = withSingleUpload("session-a", () => new Promise<string>((resolve) => (release = () => resolve("done"))));
    await expect(withSingleUpload("session-a", async () => "second")).rejects.toMatchObject({
      code: "CONFLICT",
      httpStatus: 409,
      details: { reason: "upload_in_progress" },
    });
    // Another session is not affected.
    expect(await withSingleUpload("session-b", async () => "other")).toBe("other");
    release();
    expect(await first).toBe("done");
    // The key is free again, also after a failed upload.
    await expect(withSingleUpload("session-a", async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    expect(await withSingleUpload("session-a", async () => "again")).toBe("again");
    expect(activeUploadCountForTests()).toBe(0);
  });
});
