import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { createHashingStream, sha256OfBuffer, sha256OfStream } from "./hashing";

// Published SHA-256 test vectors (FIPS 180-4 examples).
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256OfBuffer", () => {
  it("matches the known test vectors", () => {
    expect(sha256OfBuffer(Buffer.alloc(0))).toBe(EMPTY);
    expect(sha256OfBuffer(Buffer.from("abc"))).toBe(ABC);
    expect(sha256OfBuffer(new Uint8Array([0x61, 0x62, 0x63]))).toBe(ABC);
  });
});

describe("sha256OfStream", () => {
  it("hashes a stream delivered in several chunks", async () => {
    expect(await sha256OfStream(Readable.from([Buffer.from("a"), Buffer.from("b"), Buffer.from("c")]))).toBe(ABC);
    expect(await sha256OfStream(Readable.from([]))).toBe(EMPTY);
  });

  it("rejects when the stream fails", async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error("read failed"));
      },
    });
    await expect(sha256OfStream(failing)).rejects.toThrow("read failed");
  });
});

describe("HashingStream", () => {
  it("passes data through unchanged while hashing and counting bytes", async () => {
    const hasher = createHashingStream();
    const received: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk);
        callback();
      },
    });
    await pipeline(Readable.from([Buffer.from("a"), Buffer.from("bc")]), hasher, sink);
    expect(Buffer.concat(received).toString()).toBe("abc");
    expect(hasher.sizeBytes).toBe(3);
    expect(hasher.sha256).toBe(ABC);
  });

  it("does not give a digest before the stream has finished", () => {
    const hasher = createHashingStream();
    hasher.write(Buffer.from("abc"));
    expect(() => hasher.sha256).toThrow();
    expect(hasher.sizeBytes).toBe(3);
  });
});
