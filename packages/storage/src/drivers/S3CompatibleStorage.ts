// S3-compatible driver (spec 36). Works with AWS S3 and with stores that speak the
// same protocol (custom endpoint, optional path-style addressing).
//
// Objects are private: this driver never sends an ACL, so the bucket default
// applies, and the bucket must not allow public access. Downloads go through the
// application or through a short-lived signed URL.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError, isAppError } from "@dialect/domain";
import { isByteArray, toNodeReadable } from "../body";
import { mediaNotFound, objectExists, storageError } from "../errors";
import { createHashingStream, sha256OfBuffer } from "../hashing";
import { assertValidObjectKey } from "../keys";
import type {
  GetObjectOptions,
  ObjectStat,
  PutObjectInput,
  StorageAdapter,
  StoredObject,
} from "../StorageAdapter";

export type S3StorageOptions = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  // Upper limit for signed download URLs. Longer requests are shortened to this.
  // Default 900 seconds.
  maxSignedUrlTtlSeconds?: number;
  // Send `If-None-Match: *` on writes so the store itself refuses to overwrite.
  // Default true. Set to false only for a store that rejects the header; the
  // driver then relies on its existence check before the write.
  conditionalWrites?: boolean;
};

export const DEFAULT_MAX_SIGNED_URL_TTL_SECONDS = 900;

export class S3CompatibleStorage implements StorageAdapter {
  readonly driver = "s3";
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly maxSignedUrlTtlSeconds: number;
  private readonly conditionalWrites: boolean;

  // `client` is optional: pass one to reuse a configured client or to test with a
  // replaced `send` method.
  constructor(options: S3StorageOptions, client?: S3Client) {
    if (!options.bucket) {
      throw new AppError("CONFIGURATION_MISSING", "The S3 bucket name is missing.");
    }
    this.bucket = options.bucket;
    this.maxSignedUrlTtlSeconds = options.maxSignedUrlTtlSeconds ?? DEFAULT_MAX_SIGNED_URL_TTL_SECONDS;
    this.conditionalWrites = options.conditionalWrites ?? true;
    this.client =
      client ??
      new S3Client({
        region: options.region,
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        forcePathStyle: options.forcePathStyle,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      });
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    assertValidObjectKey(input.key);
    // Before the first await: a stream body is listened to from the start, so an
    // early error of the body is not missed.
    const bytes = isByteArray(input.body) ? input.body : null;
    const source = bytes ? null : toNodeReadable(input.body);
    // Checked first so that stores which ignore If-None-Match still refuse.
    if (await this.exists(input.key)) {
      source?.destroy();
      throw objectExists(input.key);
    }

    const common = {
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ...(this.conditionalWrites ? { IfNoneMatch: "*" } : {}),
    };

    try {
      if (bytes || !source) {
        const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
        await this.client.send(
          new PutObjectCommand({ ...common, Body: data, ContentLength: data.length }),
        );
        return {
          key: input.key,
          sizeBytes: data.length,
          sha256: sha256OfBuffer(data),
          driver: this.driver,
        };
      }

      // Stream: hash locally while the SDK uploads in parts.
      const hasher = createHashingStream();
      // pipeline destroys the hasher with the error when the source fails or
      // closes early, which makes the upload fail instead of waiting forever.
      let sourceError: unknown = null;
      const piping = pipeline(source, hasher).catch((error: unknown) => {
        sourceError = error;
      });
      const upload = new Upload({ client: this.client, params: { ...common, Body: hasher } });
      try {
        await upload.done();
      } catch (error) {
        source.destroy();
        hasher.destroy();
        await piping;
        throw sourceError ?? error;
      }
      await piping;
      if (sourceError) throw sourceError;
      return {
        key: input.key,
        sizeBytes: hasher.sizeBytes,
        sha256: hasher.sha256,
        driver: this.driver,
      };
    } catch (error) {
      if (isAppError(error)) throw error;
      if (isPreconditionFailure(error)) throw objectExists(input.key, error);
      throw storageError("Writing the object to S3 storage failed.", error, { key: input.key });
    }
  }

  async get(key: string, options?: GetObjectOptions): Promise<Readable> {
    assertValidObjectKey(key);
    const range = options?.range;
    if (range) {
      const valid =
        Number.isInteger(range.start) &&
        range.start >= 0 &&
        (range.end === undefined || (Number.isInteger(range.end) && range.end >= range.start));
      if (!valid) {
        throw storageError("The requested byte range cannot be served.", undefined, {
          reason: "range_not_satisfiable",
        });
      }
    }
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end ?? ""}` } : {}),
        }),
      );
      const body: unknown = response.Body;
      if (body instanceof Readable) return body;
      throw storageError("S3 storage returned a body that is not a Node stream.", undefined, { key });
    } catch (error) {
      if (isAppError(error)) throw error;
      if (isNotFound(error)) throw mediaNotFound(key, error);
      if (statusOf(error) === 416 || nameOf(error) === "InvalidRange") {
        throw storageError("The requested byte range cannot be served.", error, {
          reason: "range_not_satisfiable",
        });
      }
      throw storageError("Reading the object from S3 storage failed.", error, { key });
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    assertValidObjectKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        ...(response.LastModified ? { lastModified: response.LastModified } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw storageError("Reading object information from S3 storage failed.", error, { key });
    }
  }

  async delete(key: string): Promise<void> {
    assertValidObjectKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw storageError("Deleting the object from S3 storage failed.", error, { key });
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  // Signed GET URL. The lifetime is limited to maxSignedUrlTtlSeconds.
  async getSignedDownloadUrl(key: string, ttlSeconds: number): Promise<string> {
    assertValidObjectKey(key);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw storageError("The signed URL lifetime must be a positive number of seconds.");
    }
    const expiresIn = Math.max(1, Math.min(Math.floor(ttlSeconds), this.maxSignedUrlTtlSeconds));
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn },
      );
    } catch (error) {
      throw storageError("Creating a signed download URL failed.", error, { key });
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, detail: `bucket is reachable: ${this.bucket}` };
    } catch (error) {
      const reason = error instanceof Error ? error.name || error.message : String(error);
      return { ok: false, detail: `bucket is not reachable: ${reason}` };
    }
  }
}

function nameOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const record = error as { name?: unknown; Code?: unknown };
    if (typeof record.Code === "string") return record.Code;
    if (typeof record.name === "string") return record.name;
  }
  return undefined;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "$metadata" in error) {
    const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
    return typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
  }
  return undefined;
}

function isNotFound(error: unknown): boolean {
  const name = nameOf(error);
  return name === "NotFound" || name === "NoSuchKey" || statusOf(error) === 404;
}

function isPreconditionFailure(error: unknown): boolean {
  const name = nameOf(error);
  const status = statusOf(error);
  return (
    name === "PreconditionFailed" ||
    name === "ConditionalRequestConflict" ||
    status === 412 ||
    status === 409
  );
}
