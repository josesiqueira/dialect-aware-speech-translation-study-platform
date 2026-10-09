// SHA-256 helpers (spec 33). Every persisted media file is hashed while it is written.
import { createHash, type Hash } from "node:crypto";
import { Transform, type Readable, type TransformCallback } from "node:stream";

export function sha256OfBuffer(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256OfStream(stream: Readable): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(chunk as Buffer | string);
  }
  return hash.digest("hex");
}

// Pass-through stream that hashes and counts the bytes flowing through it.
// Read `sha256` and `sizeBytes` after the stream has finished.
export class HashingStream extends Transform {
  private readonly hash: Hash = createHash("sha256");
  private digestHex: string | null = null;
  private byteCount = 0;

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
    this.hash.update(bytes);
    this.byteCount += bytes.length;
    callback(null, bytes);
  }

  override _flush(callback: TransformCallback): void {
    this.digestHex = this.hash.digest("hex");
    callback();
  }

  // Bytes seen so far.
  get sizeBytes(): number {
    return this.byteCount;
  }

  // Hex SHA-256 of all bytes. Throws if the stream has not finished yet.
  get sha256(): string {
    if (this.digestHex === null) {
      throw new Error("HashingStream: the digest is available only after the stream has finished.");
    }
    return this.digestHex;
  }
}

export function createHashingStream(): HashingStream {
  return new HashingStream();
}
