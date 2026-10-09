// Behavior every StorageAdapter must have. Each driver test file runs these cases
// against its own driver.
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { expect, it } from "vitest";
import { sha256OfBuffer } from "../hashing";
import type { StorageAdapter } from "../StorageAdapter";

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export const SAMPLE_KEY =
  "studies/dialect-study/sessions/3f0e6c1a-58a4-4d3b-9c55-0f6a2f3b7c11/utterances/9b2d7c44-1e0a-4f6e-8a3d-5c7e9f1b2a30/source/5d1c3e7a-2b4f-4a6c-9e8d-1f3a5b7c9d2e.wav";

export const UNSAFE_KEYS = [
  "",
  "/etc/passwd",
  "../outside.wav",
  "studies/../../outside.wav",
  "studies/./a.wav",
  "studies//a.wav",
  "studies/a.wav/",
  "studies\\a.wav",
  "studies/a\u0000.wav",
  "C:/windows/a.wav",
  ".tmp/a.part",
];

// A Node-style readable that is NOT an instance of the `Readable` class of
// `node:stream`: it has `pipe`, `on`, `unpipe` and `destroy`, like a stream of
// the `readable-stream` package (the ZIP stream of `archiver` is one). The
// storage package does not depend on `readable-stream`, so the tests use this.
export class ForeignReadable extends EventEmitter {
  private readonly inner = new PassThrough();
  destroyed = false;

  constructor() {
    super();
    this.inner.on("end", () => this.emit("end"));
    this.inner.on("close", () => this.emit("close"));
    this.inner.on("error", (error) => this.emit("error", error));
  }

  // Writes one chunk and resolves when the reader has room for more.
  async write(chunk: Buffer): Promise<void> {
    if (!this.inner.write(chunk)) await new Promise<void>((resolve) => this.inner.once("drain", resolve));
  }

  end(): void {
    this.inner.end();
  }

  pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    return this.inner.pipe(destination, options);
  }

  unpipe(destination?: NodeJS.WritableStream): this {
    this.inner.unpipe(destination);
    return this;
  }

  destroy(error?: Error): this {
    this.destroyed = true;
    this.inner.destroy(error);
    return this;
  }
}

// Cases for bodies that are not `node:stream` Readable instances. Every driver
// runs them (defect E2E-1: the drivers once accepted only `instanceof Readable`).
export function runForeignBodyContract(makeStorage: () => StorageAdapter): void {
  it("stores a Node-style readable that is not a node:stream Readable instance", async () => {
    const storage = makeStorage();
    const source = new ForeignReadable();
    expect(source).not.toBeInstanceOf(Readable);
    const parts = [Buffer.alloc(70_000, 1), Buffer.alloc(70_000, 2), Buffer.from("end")];
    const pending = storage.put({
      key: "a/foreign.zip",
      body: source as unknown as NodeJS.ReadableStream,
      contentType: "application/zip",
    });
    for (const part of parts) await source.write(part);
    source.end();
    const stored = await pending;
    const whole = Buffer.concat(parts);
    expect(stored.sizeBytes).toBe(whole.length);
    expect(stored.sha256).toBe(sha256OfBuffer(whole));
    expect(await readAll(await storage.get("a/foreign.zip"))).toEqual(whole);
  });

  it("stores an async iterable of bytes", async () => {
    const storage = makeStorage();
    async function* body(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("one ");
      yield new Uint8Array([116, 119, 111]);
    }
    const stored = await storage.put({ key: "a/iterable.bin", body: body(), contentType: "x/y" });
    expect(stored.sha256).toBe(sha256OfBuffer(Buffer.from("one two")));
    expect((await readAll(await storage.get("a/iterable.bin"))).toString()).toBe("one two");
  });

  it("rejects and stores nothing when a Node-style readable fails in the middle", async () => {
    const storage = makeStorage();
    const source = new ForeignReadable();
    const pending = storage
      .put({ key: "a/foreign-failed.zip", body: source as unknown as NodeJS.ReadableStream, contentType: "application/zip" })
      .then(() => null, (reason: unknown) => reason);
    await source.write(Buffer.from("partial"));
    source.destroy(new Error("archive failed"));
    expect(await pending).toMatchObject({ name: "AppError", code: "STORAGE_ERROR" });
    expect(await storage.exists("a/foreign-failed.zip")).toBe(false);
  });

  it("rejects when a Node-style readable closes before it ended", async () => {
    const storage = makeStorage();
    const source = new ForeignReadable();
    const pending = storage
      .put({ key: "a/foreign-closed.zip", body: source as unknown as NodeJS.ReadableStream, contentType: "application/zip" })
      .then(() => null, (reason: unknown) => reason);
    await source.write(Buffer.from("partial"));
    source.destroy();
    expect(await pending).toMatchObject({ code: "STORAGE_ERROR" });
    expect(await storage.exists("a/foreign-closed.zip")).toBe(false);
  });

  it("rejects a body that is neither bytes nor a stream", async () => {
    const storage = makeStorage();
    await expect(
      storage.put({ key: "a/object.bin", body: { not: "a stream" } as unknown as Buffer, contentType: "x/y" }),
    ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(await storage.exists("a/object.bin")).toBe(false);
  });
}

export function runAdapterContract(makeStorage: () => StorageAdapter): void {
  runForeignBodyContract(makeStorage);

  it("stores bytes and reports size and SHA-256", async () => {
    const storage = makeStorage();
    const data = Buffer.from("hello storage");
    const stored = await storage.put({ key: SAMPLE_KEY, body: data, contentType: "audio/wav" });
    expect(stored).toEqual({
      key: SAMPLE_KEY,
      sizeBytes: data.length,
      sha256: sha256OfBuffer(data),
      driver: storage.driver,
    });
    expect(await readAll(await storage.get(SAMPLE_KEY))).toEqual(data);
  });

  it("accepts a Uint8Array and a stream body", async () => {
    const storage = makeStorage();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fromArray = await storage.put({ key: "a/array.bin", body: bytes, contentType: "application/octet-stream" });
    expect(fromArray.sizeBytes).toBe(5);

    const parts = [Buffer.from("first "), Buffer.from("second "), Buffer.from("third")];
    const fromStream = await storage.put({
      key: "a/stream.bin",
      body: Readable.from(parts),
      contentType: "application/octet-stream",
    });
    const whole = Buffer.concat(parts);
    expect(fromStream.sizeBytes).toBe(whole.length);
    expect(fromStream.sha256).toBe(sha256OfBuffer(whole));
    expect(await readAll(await storage.get("a/stream.bin"))).toEqual(whole);
  });

  it("refuses to overwrite an existing key and keeps the first object", async () => {
    const storage = makeStorage();
    await storage.put({ key: SAMPLE_KEY, body: Buffer.from("first"), contentType: "audio/wav" });
    await expect(
      storage.put({ key: SAMPLE_KEY, body: Buffer.from("second"), contentType: "audio/wav" }),
    ).rejects.toMatchObject({ name: "AppError", code: "CONFLICT" });
    await expect(
      storage.put({ key: SAMPLE_KEY, body: Readable.from([Buffer.from("third")]), contentType: "audio/wav" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await readAll(await storage.get(SAMPLE_KEY))).toString()).toBe("first");
  });

  it("lets only one of two concurrent writes to the same key succeed", async () => {
    const storage = makeStorage();
    const results = await Promise.allSettled([
      storage.put({ key: "a/race.bin", body: Readable.from([Buffer.from("one")]), contentType: "x/y" }),
      storage.put({ key: "a/race.bin", body: Readable.from([Buffer.from("two")]), contentType: "x/y" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
  });

  it("serves inclusive byte ranges", async () => {
    const storage = makeStorage();
    const data = Buffer.from("0123456789");
    await storage.put({ key: "a/range.bin", body: data, contentType: "x/y" });
    expect((await readAll(await storage.get("a/range.bin", { range: { start: 2, end: 5 } }))).toString()).toBe("2345");
    expect((await readAll(await storage.get("a/range.bin", { range: { start: 7 } }))).toString()).toBe("789");
    expect((await readAll(await storage.get("a/range.bin", { range: { start: 0, end: 0 } }))).toString()).toBe("0");
    // An end past the last byte is limited to the object size.
    expect((await readAll(await storage.get("a/range.bin", { range: { start: 8, end: 500 } }))).toString()).toBe("89");
  });

  it("rejects a byte range that cannot be served", async () => {
    const storage = makeStorage();
    await storage.put({ key: "a/range.bin", body: Buffer.from("0123456789"), contentType: "x/y" });
    for (const range of [{ start: 10 }, { start: -1 }, { start: 5, end: 2 }, { start: 1.5 }]) {
      await expect(storage.get("a/range.bin", { range })).rejects.toMatchObject({
        code: "STORAGE_ERROR",
        details: { reason: "range_not_satisfiable" },
      });
    }
  });

  it("reports a missing object as MEDIA_NOT_FOUND on get and as null on stat", async () => {
    const storage = makeStorage();
    await expect(storage.get("a/missing.wav")).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
    expect(await storage.stat("a/missing.wav")).toBeNull();
    expect(await storage.exists("a/missing.wav")).toBe(false);
  });

  it("returns size and modification time from stat", async () => {
    const storage = makeStorage();
    await storage.put({ key: "a/stat.bin", body: Buffer.alloc(1234), contentType: "x/y" });
    const stat = await storage.stat("a/stat.bin");
    expect(stat?.sizeBytes).toBe(1234);
    expect(stat?.lastModified).toBeInstanceOf(Date);
    expect(await storage.exists("a/stat.bin")).toBe(true);
  });

  it("deletes idempotently", async () => {
    const storage = makeStorage();
    await storage.put({ key: "a/delete.bin", body: Buffer.from("x"), contentType: "x/y" });
    await storage.delete("a/delete.bin");
    expect(await storage.exists("a/delete.bin")).toBe(false);
    await expect(storage.delete("a/delete.bin")).resolves.toBeUndefined();
    await expect(storage.delete("a/never-existed.bin")).resolves.toBeUndefined();
  });

  it("rejects unsafe keys on every operation", async () => {
    const storage = makeStorage();
    for (const key of UNSAFE_KEYS) {
      const expected = { code: "STORAGE_ERROR" };
      await expect(storage.put({ key, body: Buffer.from("x"), contentType: "x/y" })).rejects.toMatchObject(expected);
      await expect(storage.get(key)).rejects.toMatchObject(expected);
      await expect(storage.stat(key)).rejects.toMatchObject(expected);
      await expect(storage.exists(key)).rejects.toMatchObject(expected);
      await expect(storage.delete(key)).rejects.toMatchObject(expected);
    }
  });

  it("reports a failing upload stream as STORAGE_ERROR and stores nothing", async () => {
    const storage = makeStorage();
    const failing = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("connection lost"));
      },
    });
    const error = await storage
      .put({ key: "a/failed.bin", body: failing, contentType: "x/y" })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toMatchObject({ code: "STORAGE_ERROR" });
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(await storage.exists("a/failed.bin")).toBe(false);
  });

  it("passes the health check", async () => {
    const storage = makeStorage();
    expect((await storage.healthCheck()).ok).toBe(true);
  });
}
