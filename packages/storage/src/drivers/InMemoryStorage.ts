// In-memory driver for unit tests. Same semantics as the other drivers:
// no overwrite, inclusive byte ranges, idempotent delete.
import { Readable } from "node:stream";
import { isByteArray, toNodeReadable } from "../body";
import { mediaNotFound, objectExists, storageError, toStorageError } from "../errors";
import { sha256OfBuffer } from "../hashing";
import { assertValidObjectKey } from "../keys";
import { resolveRange } from "../range";
import type {
  GetObjectOptions,
  ObjectStat,
  PutObjectInput,
  StorageAdapter,
  StoredObject,
} from "../StorageAdapter";

type Entry = { data: Buffer; contentType: string; lastModified: Date };

export class InMemoryStorage implements StorageAdapter {
  readonly driver = "memory";
  private readonly objects = new Map<string, Entry>();

  async put(input: PutObjectInput): Promise<StoredObject> {
    assertValidObjectKey(input.key);
    if (this.objects.has(input.key)) throw objectExists(input.key);
    let data: Buffer;
    try {
      data = await toBuffer(input.body);
    } catch (error) {
      throw toStorageError(error, "Reading the upload failed.", { key: input.key });
    }
    // The body may have taken time to read: check again before storing.
    if (this.objects.has(input.key)) throw objectExists(input.key);
    this.objects.set(input.key, { data, contentType: input.contentType, lastModified: new Date() });
    return {
      key: input.key,
      sizeBytes: data.length,
      sha256: sha256OfBuffer(data),
      driver: this.driver,
    };
  }

  async get(key: string, options?: GetObjectOptions): Promise<Readable> {
    assertValidObjectKey(key);
    const entry = this.objects.get(key);
    if (!entry) throw mediaNotFound(key);
    const range = resolveRange(options?.range, entry.data.length);
    if (!range) return Readable.from([entry.data]);
    return Readable.from([entry.data.subarray(range.start, range.end + 1)]);
  }

  async stat(key: string): Promise<ObjectStat | null> {
    assertValidObjectKey(key);
    const entry = this.objects.get(key);
    return entry ? { sizeBytes: entry.data.length, lastModified: entry.lastModified } : null;
  }

  async delete(key: string): Promise<void> {
    assertValidObjectKey(key);
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    assertValidObjectKey(key);
    return this.objects.has(key);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: `${this.objects.size} objects in memory` };
  }

  // Test helpers (not part of StorageAdapter).
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  contentTypeOf(key: string): string | undefined {
    return this.objects.get(key)?.contentType;
  }

  clear(): void {
    this.objects.clear();
  }
}

async function toBuffer(body: PutObjectInput["body"]): Promise<Buffer> {
  if (isByteArray(body)) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of toNodeReadable(body) as AsyncIterable<unknown>) {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else throw storageError("The upload stream produced a value that is not bytes.");
  }
  return Buffer.concat(chunks);
}
