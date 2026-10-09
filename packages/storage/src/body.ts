// Turns any accepted `put` body into a `Readable` of `node:stream`, the one
// stream type the drivers hash and write.
//
// A body is not always an instance of the `Readable` class of `node:stream`.
// The ZIP stream of `archiver`, for example, is a `Transform` of the
// `readable-stream` package: it behaves like a Node stream but is built from a
// separate copy of the stream classes, so `instanceof Readable` is false. The
// drivers therefore accept every Node-style readable (an object with `pipe` and
// `on`) and every async iterable of bytes.
import { PassThrough, Readable } from "node:stream";
import { storageError } from "./errors";
import type { PutObjectBody } from "./StorageAdapter";

type NodeStyleReadable = {
  pipe(destination: NodeJS.WritableStream, options?: { end?: boolean }): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  unpipe?(destination?: NodeJS.WritableStream): unknown;
  destroy?(error?: Error): unknown;
};

export function isByteArray(body: unknown): body is Buffer | Uint8Array {
  return Buffer.isBuffer(body) || body instanceof Uint8Array;
}

function isNodeStyleReadable(body: unknown): body is NodeStyleReadable {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as { pipe?: unknown; on?: unknown };
  return typeof candidate.pipe === "function" && typeof candidate.on === "function";
}

function isAsyncIterable(body: unknown): body is AsyncIterable<unknown> {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

// Returns a `node:stream` Readable for the body.
//
// For a stream that is not a `node:stream` Readable the bytes are piped through
// a PassThrough, so backpressure still reaches the source. An error of the
// source destroys the returned stream with that error. A source that closes
// before it ended destroys it too, so a write never waits forever for bytes
// that will not come. When the returned stream is destroyed (the write failed),
// the source is destroyed as well, so that it stops producing.
export function toNodeReadable(body: PutObjectBody): Readable {
  if (isByteArray(body)) return Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  if (body instanceof Readable) return body;
  if (isNodeStyleReadable(body)) return wrapNodeStyleReadable(body);
  if (isAsyncIterable(body)) return Readable.from(body, { objectMode: false });
  throw storageError("The object body is not bytes, a readable stream or an async iterable of bytes.");
}

function wrapNodeStyleReadable(source: NodeStyleReadable): Readable {
  const output = new PassThrough();
  // The driver may attach its own listeners a moment later (after an existence
  // check). Without this listener an early error would be an uncaught exception.
  // The stream stays destroyed with the error, so the write still fails with it.
  output.on("error", () => undefined);
  let sourceEnded = false;
  source.on("end", () => {
    sourceEnded = true;
  });
  source.on("error", (error: Error) => {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  source.on("close", () => {
    if (!sourceEnded && !output.destroyed) {
      output.destroy(new Error("The source stream closed before it ended."));
    }
  });
  output.on("close", () => {
    if (sourceEnded) return;
    // The reader stopped early: stop the source too.
    try {
      source.unpipe?.(output);
      source.destroy?.();
    } catch {
      // The source is already stopped.
    }
  });
  if ((source as { destroyed?: unknown }).destroyed === true) {
    output.destroy(new Error("The source stream was already closed."));
    return output;
  }
  source.pipe(output);
  return output;
}
