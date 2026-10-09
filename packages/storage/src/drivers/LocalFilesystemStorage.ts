// Local filesystem driver (spec 35). For development and a single-machine setup.
//
// Write path: the body is streamed into a temporary file under `<root>/.tmp` (same
// filesystem as the destination), hashed while streaming, flushed with fsync, and
// then published under its final name. Publishing uses a hard link followed by
// removal of the temporary name: unlike rename(2), link(2) fails when the
// destination exists, which gives an atomic "create only if absent". On filesystems
// without hard links the driver falls back to an existence check and rename.
// A reader therefore sees either no file or the complete file, never a partial one.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "@dialect/domain";
import { toNodeReadable } from "../body";
import { errnoCode, mediaNotFound, objectExists, storageError, toStorageError } from "../errors";
import { createHashingStream } from "../hashing";
import { assertValidObjectKey, RESERVED_KEY_PREFIX } from "../keys";
import { resolveRange } from "../range";
import type {
  GetObjectOptions,
  ObjectStat,
  PutObjectInput,
  StorageAdapter,
  StoredObject,
} from "../StorageAdapter";

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"]);

export class LocalFilesystemStorage implements StorageAdapter {
  readonly driver = "local";
  readonly root: string;
  private readonly tempDir: string;

  // `root` must be an absolute path. Use storageConfigFromEnv to resolve a relative
  // LOCAL_STORAGE_ROOT against the repository root.
  constructor(options: { root: string }) {
    if (typeof options.root !== "string" || options.root.length === 0 || !path.isAbsolute(options.root)) {
      throw new AppError("CONFIGURATION_MISSING", "The local storage root must be an absolute path.");
    }
    const root = path.resolve(options.root);
    // Audio is never publicly addressable (spec 35): refuse a root inside any
    // directory named "public", which Next.js would serve as static files.
    if (root.split(path.sep).some((segment) => segment.toLowerCase() === "public")) {
      throw new AppError(
        "CONFIGURATION_MISSING",
        'The local storage root must not be inside a "public" directory.',
      );
    }
    this.root = root;
    this.tempDir = path.join(root, RESERVED_KEY_PREFIX);
  }

  // Absolute path for a key, guaranteed to be inside the root.
  private resolveKey(key: string): string {
    assertValidObjectKey(key);
    const resolved = path.resolve(this.root, ...key.split("/"));
    if (!resolved.startsWith(this.root + path.sep)) {
      throw storageError("Invalid storage key: the key escapes the storage root.");
    }
    return resolved;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const finalPath = this.resolveKey(input.key);
    const tempPath = path.join(this.tempDir, `${randomUUID()}.part`);
    let source: Readable | null = null;
    try {
      // Before the first await: a stream body is listened to from the start, so
      // an early error of the body is not missed.
      source = toNodeReadable(input.body);
      // Fail early, before reading the body, when the key is already taken.
      if (await this.isFile(finalPath)) throw objectExists(input.key);

      await fs.mkdir(this.tempDir, { recursive: true });
      const hasher = createHashingStream();
      await pipeline(source, hasher, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));

      const handle = await fs.open(tempPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }

      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      await this.publish(tempPath, finalPath, input.key);
      await syncDirectory(path.dirname(finalPath));

      return {
        key: input.key,
        sizeBytes: hasher.sizeBytes,
        sha256: hasher.sha256,
        driver: this.driver,
      };
    } catch (error) {
      source?.destroy();
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw toStorageError(error, "Writing the object to local storage failed.", { key: input.key });
    }
  }

  // Moves the finished temporary file to its final name without replacing an
  // existing file.
  private async publish(tempPath: string, finalPath: string, key: string): Promise<void> {
    try {
      await fs.link(tempPath, finalPath);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "EEXIST") throw objectExists(key, error);
      if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error;
      // No hard link support on this filesystem: check, then rename.
      if (await this.isFile(finalPath)) throw objectExists(key);
      await fs.rename(tempPath, finalPath);
      return;
    }
    await fs.rm(tempPath, { force: true });
  }

  async get(key: string, options?: GetObjectOptions): Promise<Readable> {
    const filePath = this.resolveKey(key);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(filePath, "r");
    } catch (error) {
      if (isMissing(error)) throw mediaNotFound(key, error);
      throw storageError("Reading the object from local storage failed.", error, { key });
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw mediaNotFound(key);
      const range = resolveRange(options?.range, stats.size);
      // The stream closes the file handle when it ends or is destroyed.
      return range
        ? handle.createReadStream({ start: range.start, end: range.end })
        : handle.createReadStream();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw toStorageError(error, "Reading the object from local storage failed.", { key });
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const filePath = this.resolveKey(key);
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) return null;
      return { sizeBytes: stats.size, lastModified: stats.mtime };
    } catch (error) {
      if (isMissing(error)) return null;
      throw storageError("Reading object information from local storage failed.", error, { key });
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveKey(key);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (isMissing(error)) return;
      throw storageError("Deleting the object from local storage failed.", error, { key });
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  // Verifies that the root is writable by writing and removing a probe file.
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const probePath = path.join(this.tempDir, `health-${randomUUID()}.probe`);
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      await fs.writeFile(probePath, "ok", { flag: "wx", mode: 0o600 });
      await fs.rm(probePath);
      return { ok: true, detail: `local storage root is writable: ${this.root}` };
    } catch (error) {
      await fs.rm(probePath, { force: true }).catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: `local storage root is not writable: ${reason}` };
    }
  }

  private async isFile(filePath: string): Promise<boolean> {
    try {
      return (await fs.stat(filePath)).isFile();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

// Flushes the directory entry so the new name survives a crash. Not supported on
// every platform, so a failure here is ignored.
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort only.
  }
}
