// A recording that was rejected or replaced must not stay in storage because one
// delete call failed (spec 10). The failed delete is written to the job queue
// and the worker removes the object later.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, mediaAssets } from "@dialect/db";
import { processOneJob } from "../jobs";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import type { ServiceContext } from "../context";
import {
  createUtterance,
  DELETE_STORAGE_OBJECT_JOB,
  discardCandidate,
  jobHandlers,
  startTask,
  uploadUtteranceAudio,
} from "./index";
import { createTestStudy, sessionAtTasks, sineWav } from "./test-support";

let t: TestServiceContext;

beforeAll(async () => {
  t = await createTestServiceContext();
});
afterAll(async () => {
  await t.cleanup();
});

// The test storage with a delete() that fails while `broken` is true.
function flakyStorage(state: { broken: boolean }): ServiceContext["storage"] {
  const storage = Object.create(t.storage) as ServiceContext["storage"];
  storage.delete = async (key) => {
    if (state.broken) throw new Error("storage is not reachable");
    return t.storage.delete(key);
  };
  return storage;
}

const cleanupJobs = async () =>
  (await t.ctx.db.select().from(jobs)).filter((job) => job.type === DELETE_STORAGE_OBJECT_JOB);

async function uploadedCandidate(ctx: ServiceContext) {
  const study = await createTestStudy(t.ctx.db);
  const { session, state } = await sessionAtTasks(ctx, study.slug);
  await startTask(ctx, session, state.task.presentationId);
  const { utteranceId } = await createUtterance(ctx, session, { presentationId: state.task.presentationId, turnIndex: 0 });
  const upload = await uploadUtteranceAudio(ctx, session, { utteranceId, data: sineWav() });
  const [media] = await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, upload.mediaAssetId));
  return { session, utteranceId, storageKey: media!.storageKey };
}

describe("clean-up of a discarded recording whose storage delete failed", () => {
  it("queues a delete_storage_object job, and the worker then removes the object", async () => {
    const state = { broken: true };
    const ctx: ServiceContext = { ...t.ctx, storage: flakyStorage(state) };
    const { session, utteranceId, storageKey } = await uploadedCandidate(ctx);

    // The participant records again: the row goes, the storage delete fails.
    await discardCandidate(ctx, session, { utteranceId });
    expect(await t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.storageKey, storageKey))).toHaveLength(0);
    expect(t.storage.keys()).toContain(storageKey);

    const queued = (await cleanupJobs()).filter((job) => (job.payloadJson as { storageKey?: string }).storageKey === storageKey);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: "delete_storage_object",
      status: "queued",
      idempotencyKey: `delete_storage_object:${storageKey}`,
      maxAttempts: 8,
    });

    // Storage is still down: the job fails and stays for a retry.
    const options = { deps: { ctx }, handlers: jobHandlers, workerId: "test-worker", types: [DELETE_STORAGE_OBJECT_JOB] };
    expect(await processOneJob(options)).toBe("processed");
    const [retrying] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, queued[0]!.id));
    expect(retrying).toMatchObject({ status: "queued", attempts: 1 });
    expect(t.storage.keys()).toContain(storageKey);

    // Storage is back: the retry removes the object.
    state.broken = false;
    t.clock.advance(10 * 60 * 1000);
    expect(await processOneJob(options)).toBe("processed");
    const [done] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, queued[0]!.id));
    expect(done!.status).toBe("succeeded");
    expect(t.storage.keys()).not.toContain(storageKey);
  });

  it("never deletes an object that a media record points at", async () => {
    const { storageKey } = await uploadedCandidate(t.ctx);
    const [job] = await t.ctx.db
      .insert(jobs)
      .values({
        type: DELETE_STORAGE_OBJECT_JOB,
        payloadJson: { storageKey },
        idempotencyKey: `delete_storage_object:${storageKey}`,
        availableAt: t.clock.now(),
      })
      .returning();
    await processOneJob({ deps: { ctx: t.ctx }, handlers: jobHandlers, workerId: "test-worker", types: [DELETE_STORAGE_OBJECT_JOB] });
    const [after] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(after!.status).toBe("failed");
    expect(after!.lastError).toContain("INVALID_STATE");
    expect(t.storage.keys()).toContain(storageKey);
  });
});
