// Job handler `delete_storage_object`: removes a stored file whose database row
// is already gone (spec 10: the audio of a rejected or replaced attempt is not
// kept). deleteStoredObjects() in ./internal.ts queues the job when the direct
// delete failed. The queue retries with backoff, up to the job's max_attempts.
//
// Safety: the handler never deletes an object that a media_assets row points
// at. Storage keys contain a random asset id, so a key is never reused, and the
// check makes a wrong or forged payload harmless.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { mediaAssets } from "@dialect/db";
import { AppError } from "@dialect/domain";
import type { JobHandler, JobHandlerRegistry } from "../jobs/worker";
import { DELETE_STORAGE_OBJECT_JOB } from "./internal";

const payloadSchema = z.looseObject({ storageKey: z.string().min(1).max(1024) });

export const deleteStorageObjectHandler: JobHandler = async ({ ctx }, job) => {
  const parsed = payloadSchema.safeParse(job.payloadJson);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "The payload of the delete_storage_object job has no storage key.", {
      jobId: job.id,
    });
  }
  const { storageKey } = parsed.data;
  const [referenced] = await ctx.db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(eq(mediaAssets.storageKey, storageKey))
    .limit(1);
  if (referenced) {
    // Not retryable: someone has to look at why a referenced object was queued.
    throw new AppError(
      "INVALID_STATE",
      "The stored object belongs to a media record and is not removed by the clean-up job.",
      { jobId: job.id, mediaAssetId: referenced.id },
    );
  }
  // A storage error is thrown unchanged, so the queue retries the job. Deleting
  // an object that is already gone succeeds in every storage driver.
  await ctx.storage.delete(storageKey);
  ctx.logger.info({ jobId: job.id, storageKey }, "removed a stored object that had no database row");
};

// Keyed by job type. The worker registers this registry next to the processing
// and export handlers.
export const jobHandlers: JobHandlerRegistry = {
  [DELETE_STORAGE_OBJECT_JOB]: deleteStorageObjectHandler,
};
