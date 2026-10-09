// Storage contract (spec 34). Audio bytes live here, never in PostgreSQL.
// Objects are private: there is no public URL.
import type { Readable } from "node:stream";

// A Node-style readable is any object with `pipe` and `on`, also one that is not
// an instance of the `Readable` class of `node:stream` (for example a stream of
// the `readable-stream` package, such as the ZIP stream of `archiver`).
export type PutObjectBody =
  | Buffer
  | Uint8Array
  | Readable
  | NodeJS.ReadableStream
  | AsyncIterable<Uint8Array | string>;

export type PutObjectInput = {
  key: string;
  body: PutObjectBody;
  contentType: string;
};

export type StoredObject = {
  key: string;
  sizeBytes: number;
  // Hex SHA-256 of the stored bytes, computed while writing.
  sha256: string;
  driver: string;
};

export type GetObjectOptions = {
  // Inclusive byte range, for HTTP Range requests.
  range?: { start: number; end?: number };
};

export type ObjectStat = { sizeBytes: number; lastModified?: Date };

export interface StorageAdapter {
  readonly driver: string;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string, options?: GetObjectOptions): Promise<Readable>;
  stat(key: string): Promise<ObjectStat | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getSignedDownloadUrl?(key: string, ttlSeconds: number): Promise<string>;
  // Used by the readiness endpoint and the Settings page.
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
