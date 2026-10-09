import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { sha256OfBuffer } from "../hashing";
import { readAll, runForeignBodyContract, UNSAFE_KEYS } from "../testing/adapterContract";
import { S3CompatibleStorage, type S3StorageOptions } from "./S3CompatibleStorage";

const OPTIONS: S3StorageOptions = {
  endpoint: "http://127.0.0.1:9000",
  region: "eu-north-1",
  bucket: "dialect-test",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  forcePathStyle: true,
};

function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof Readable) return readAll(body);
  throw new Error("unexpected body type in mocked S3 client");
}

// A real S3Client (so the SDK's own upload and signing code runs) whose `send`
// is replaced by a small in-memory bucket. No network request is made.
function mockedClient(behavior: { ignoreIfNoneMatch?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const multipart = new Map<string, Map<number, Buffer>>();
  const commands: unknown[] = [];
  const client = new S3Client({
    region: OPTIONS.region,
    endpoint: OPTIONS.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: OPTIONS.accessKeyId, secretAccessKey: OPTIONS.secretAccessKey },
  });

  const send = vi.spyOn(client, "send") as unknown as ReturnType<typeof vi.fn>;
  send.mockImplementation(async (command: unknown) => {
    commands.push(command);
    if (command instanceof HeadBucketCommand) return {};
    if (command instanceof HeadObjectCommand) {
      const data = objects.get(command.input.Key as string);
      if (!data) throw s3Error("NotFound", 404);
      return { ContentLength: data.length, LastModified: new Date("2026-10-03T10:00:00Z") };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key as string;
      if (!behavior.ignoreIfNoneMatch && command.input.IfNoneMatch === "*" && objects.has(key)) {
        throw s3Error("PreconditionFailed", 412);
      }
      objects.set(key, await bodyToBuffer(command.input.Body));
      return { ETag: '"etag"' };
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const uploadId = randomUUID();
      multipart.set(uploadId, new Map());
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      const parts = multipart.get(command.input.UploadId as string);
      if (!parts) throw s3Error("NoSuchUpload", 404);
      parts.set(command.input.PartNumber as number, await bodyToBuffer(command.input.Body));
      return { ETag: `"part-${command.input.PartNumber}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const key = command.input.Key as string;
      const parts = multipart.get(command.input.UploadId as string);
      if (!parts) throw s3Error("NoSuchUpload", 404);
      if (command.input.IfNoneMatch === "*" && objects.has(key)) throw s3Error("PreconditionFailed", 412);
      const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
      objects.set(key, Buffer.concat(ordered));
      return { ETag: '"etag"' };
    }
    if (command instanceof GetObjectCommand) {
      const data = objects.get(command.input.Key as string);
      if (!data) throw s3Error("NoSuchKey", 404);
      const range = command.input.Range;
      if (!range) return { Body: Readable.from([data]) };
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) throw s3Error("InvalidArgument", 400);
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      if (start >= data.length) throw s3Error("InvalidRange", 416);
      return { Body: Readable.from([data.subarray(start, end + 1)]) };
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(command.input.Key as string);
      return {};
    }
    throw new Error(`unexpected command in mocked S3 client: ${(command as object).constructor.name}`);
  });

  const commandsOf = <T>(type: new (...args: never[]) => T): T[] =>
    commands.filter((command): command is T => command instanceof type);

  return { client, objects, send, commandsOf };
}

describe("S3CompatibleStorage with a mocked client", () => {
  it("has the driver name s3", () => {
    expect(new S3CompatibleStorage(OPTIONS, mockedClient().client).driver).toBe("s3");
  });

  it("uploads a buffer with a locally computed SHA-256, a content type and no ACL", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    const data = Buffer.from("s3 object body");
    const stored = await storage.put({ key: "a/object.wav", body: data, contentType: "audio/wav" });

    expect(stored).toEqual({
      key: "a/object.wav",
      sizeBytes: data.length,
      sha256: sha256OfBuffer(data),
      driver: "s3",
    });
    const [put] = mock.commandsOf(PutObjectCommand);
    expect(put?.input).toMatchObject({
      Bucket: "dialect-test",
      Key: "a/object.wav",
      ContentType: "audio/wav",
      ContentLength: data.length,
      IfNoneMatch: "*",
    });
    expect(put?.input.ACL).toBeUndefined();
    expect(put?.input.GrantRead).toBeUndefined();
    expect(mock.objects.get("a/object.wav")).toEqual(data);
  });

  it("uploads a small stream and hashes it while streaming", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    const parts = [Buffer.from("alpha "), Buffer.from("beta "), Buffer.from("gamma")];
    const whole = Buffer.concat(parts);
    const stored = await storage.put({ key: "a/stream.webm", body: Readable.from(parts), contentType: "audio/webm" });

    expect(stored.sizeBytes).toBe(whole.length);
    expect(stored.sha256).toBe(sha256OfBuffer(whole));
    expect(mock.objects.get("a/stream.webm")).toEqual(whole);
    const [put] = mock.commandsOf(PutObjectCommand);
    expect(put?.input.IfNoneMatch).toBe("*");
    expect(put?.input.ACL).toBeUndefined();
  });

  it("uploads a large stream in parts and still reports the right hash", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    const whole = randomBytes(6 * 1024 * 1024 + 123);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < whole.length; offset += 256 * 1024) {
      chunks.push(whole.subarray(offset, offset + 256 * 1024));
    }
    const stored = await storage.put({ key: "a/large.zip", body: Readable.from(chunks), contentType: "application/zip" });

    expect(stored.sizeBytes).toBe(whole.length);
    expect(stored.sha256).toBe(sha256OfBuffer(whole));
    expect(mock.commandsOf(UploadPartCommand).length).toBe(2);
    const [complete] = mock.commandsOf(CompleteMultipartUploadCommand);
    expect(complete?.input.IfNoneMatch).toBe("*");
    expect(sha256OfBuffer(mock.objects.get("a/large.zip") as Buffer)).toBe(stored.sha256);
  });

  it("refuses to overwrite: existence check before the write", async () => {
    const mock = mockedClient({ ignoreIfNoneMatch: true });
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    await storage.put({ key: "a/once.wav", body: Buffer.from("first"), contentType: "audio/wav" });
    await expect(
      storage.put({ key: "a/once.wav", body: Buffer.from("second"), contentType: "audio/wav" }),
    ).rejects.toMatchObject({ name: "AppError", code: "CONFLICT" });
    expect(mock.commandsOf(PutObjectCommand)).toHaveLength(1);
    expect(mock.objects.get("a/once.wav")?.toString()).toBe("first");
  });

  it("refuses to overwrite: the store rejects the conditional write", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    // Another writer creates the object between the existence check and the write.
    mock.send.mockImplementationOnce(async () => {
      throw s3Error("NotFound", 404);
    });
    mock.objects.set("a/race.wav", Buffer.from("other writer"));
    const error = await storage
      .put({ key: "a/race.wav", body: Buffer.from("mine"), contentType: "audio/wav" })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect((error as Error).cause).toMatchObject({ name: "PreconditionFailed" });
    expect(mock.objects.get("a/race.wav")?.toString()).toBe("other writer");
  });

  it("omits If-None-Match when conditional writes are turned off", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage({ ...OPTIONS, conditionalWrites: false }, mock.client);
    await storage.put({ key: "a/plain.wav", body: Buffer.from("x"), contentType: "audio/wav" });
    expect(mock.commandsOf(PutObjectCommand)[0]?.input.IfNoneMatch).toBeUndefined();
    await expect(
      storage.put({ key: "a/plain.wav", body: Buffer.from("y"), contentType: "audio/wav" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("wraps an upload failure as STORAGE_ERROR with the original error as cause", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    const original = s3Error("InternalError", 500);
    mock.send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) throw s3Error("NotFound", 404);
      throw original;
    });
    const error = await storage
      .put({ key: "a/fail.wav", body: Buffer.from("x"), contentType: "audio/wav" })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toMatchObject({ name: "AppError", code: "STORAGE_ERROR" });
    expect((error as Error).cause).toBe(original);
  });

  describe("bodies that are not node:stream Readable instances", () => {
    runForeignBodyContract(() => new S3CompatibleStorage(OPTIONS, mockedClient().client));
  });

  it("reports a failing source stream as STORAGE_ERROR and stores nothing", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    const failing = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("connection lost"));
      },
    });
    await expect(
      storage.put({ key: "a/broken.webm", body: failing, contentType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(mock.objects.has("a/broken.webm")).toBe(false);
  });

  it("reads whole objects and byte ranges", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    await storage.put({ key: "a/range.bin", body: Buffer.from("0123456789"), contentType: "x/y" });

    expect((await readAll(await storage.get("a/range.bin"))).toString()).toBe("0123456789");
    expect((await readAll(await storage.get("a/range.bin", { range: { start: 2, end: 5 } }))).toString()).toBe("2345");
    expect((await readAll(await storage.get("a/range.bin", { range: { start: 7 } }))).toString()).toBe("789");
    const ranges = mock.commandsOf(GetObjectCommand).map((command) => command.input.Range);
    expect(ranges).toEqual([undefined, "bytes=2-5", "bytes=7-"]);
  });

  it("rejects byte ranges that cannot be served", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    await storage.put({ key: "a/range.bin", body: Buffer.from("0123456789"), contentType: "x/y" });
    const expected = { code: "STORAGE_ERROR", details: { reason: "range_not_satisfiable" } };
    await expect(storage.get("a/range.bin", { range: { start: -1 } })).rejects.toMatchObject(expected);
    await expect(storage.get("a/range.bin", { range: { start: 5, end: 2 } })).rejects.toMatchObject(expected);
    await expect(storage.get("a/range.bin", { range: { start: 10 } })).rejects.toMatchObject(expected);
  });

  it("maps a missing object to MEDIA_NOT_FOUND, null and false", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    const error = await storage.get("a/missing.wav").then(() => null, (reason: unknown) => reason);
    expect(error).toMatchObject({ name: "AppError", code: "MEDIA_NOT_FOUND" });
    expect((error as Error).cause).toMatchObject({ name: "NoSuchKey" });
    expect(await storage.stat("a/missing.wav")).toBeNull();
    expect(await storage.exists("a/missing.wav")).toBe(false);
  });

  it("returns size and modification time from stat", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    await storage.put({ key: "a/stat.bin", body: Buffer.alloc(77), contentType: "x/y" });
    expect(await storage.stat("a/stat.bin")).toEqual({
      sizeBytes: 77,
      lastModified: new Date("2026-10-03T10:00:00Z"),
    });
    expect(await storage.exists("a/stat.bin")).toBe(true);
  });

  it("wraps other stat and get failures as STORAGE_ERROR", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    mock.send.mockImplementation(async () => {
      throw s3Error("AccessDenied", 403);
    });
    await expect(storage.stat("a/x.bin")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(storage.get("a/x.bin")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(storage.delete("a/x.bin")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("deletes idempotently", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    await storage.put({ key: "a/delete.bin", body: Buffer.from("x"), contentType: "x/y" });
    await storage.delete("a/delete.bin");
    await expect(storage.delete("a/delete.bin")).resolves.toBeUndefined();
    expect(mock.objects.has("a/delete.bin")).toBe(false);
    expect(mock.commandsOf(DeleteObjectCommand)).toHaveLength(2);
  });

  it("rejects unsafe keys before any request is sent", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    for (const key of UNSAFE_KEYS) {
      const expected = { code: "STORAGE_ERROR" };
      await expect(storage.put({ key, body: Buffer.from("x"), contentType: "x/y" })).rejects.toMatchObject(expected);
      await expect(storage.get(key)).rejects.toMatchObject(expected);
      await expect(storage.stat(key)).rejects.toMatchObject(expected);
      await expect(storage.delete(key)).rejects.toMatchObject(expected);
      await expect(storage.getSignedDownloadUrl(key, 60)).rejects.toMatchObject(expected);
    }
    expect(mock.send).not.toHaveBeenCalled();
  });

  it("creates a signed download URL with a limited lifetime", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    const url = new URL(await storage.getSignedDownloadUrl("a/object.wav", 60));
    expect(url.origin).toBe("http://127.0.0.1:9000");
    expect(url.pathname).toBe("/dialect-test/a/object.wav");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // Signing is local: no request is sent.
    expect(mock.send).not.toHaveBeenCalled();

    const long = new URL(await storage.getSignedDownloadUrl("a/object.wav", 86_400));
    expect(long.searchParams.get("X-Amz-Expires")).toBe("900");
    await expect(storage.getSignedDownloadUrl("a/object.wav", 0)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("checks health with HeadBucket", async () => {
    const mock = mockedClient();
    const storage = new S3CompatibleStorage(OPTIONS, mock.client);
    expect(await storage.healthCheck()).toMatchObject({ ok: true });
    expect(mock.commandsOf(HeadBucketCommand)[0]?.input).toEqual({ Bucket: "dialect-test" });

    mock.send.mockImplementation(async () => {
      throw s3Error("NoSuchBucket", 404);
    });
    const health = await storage.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("NoSuchBucket");
  });

  it("builds its own client when none is passed", () => {
    expect(() => new S3CompatibleStorage(OPTIONS)).not.toThrow();
    expect(() => new S3CompatibleStorage({ ...OPTIONS, bucket: "" })).toThrowError(
      expect.objectContaining({ code: "CONFIGURATION_MISSING" }),
    );
  });
});

// Runs only against a real S3-compatible store, for example a local MinIO:
// TEST_S3_ENDPOINT, TEST_S3_BUCKET, TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY,
// and optionally TEST_S3_REGION.
describe.skipIf(!process.env.TEST_S3_ENDPOINT)("S3CompatibleStorage against TEST_S3_ENDPOINT", () => {
  const storage = (): S3CompatibleStorage =>
    new S3CompatibleStorage({
      endpoint: process.env.TEST_S3_ENDPOINT,
      region: process.env.TEST_S3_REGION ?? "us-east-1",
      bucket: process.env.TEST_S3_BUCKET ?? "dialect-test",
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "",
      forcePathStyle: true,
    });

  it("writes, reads, refuses to overwrite and deletes", async () => {
    const adapter = storage();
    expect((await adapter.healthCheck()).ok).toBe(true);
    const key = `integration-test/${randomUUID()}.bin`;
    const data = randomBytes(4096);
    try {
      const stored = await adapter.put({ key, body: Readable.from([data]), contentType: "application/octet-stream" });
      expect(stored.sha256).toBe(sha256OfBuffer(data));
      expect((await adapter.stat(key))?.sizeBytes).toBe(4096);
      expect(await readAll(await adapter.get(key, { range: { start: 10, end: 19 } }))).toEqual(data.subarray(10, 20));
      await expect(adapter.put({ key, body: data, contentType: "application/octet-stream" })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    } finally {
      await adapter.delete(key);
    }
    expect(await adapter.exists(key)).toBe(false);
  });
});
