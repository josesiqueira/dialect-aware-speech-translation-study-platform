// A failure of the job queue must never fail a participant's submission
// (spec 29, 110.8). The queue module is replaced so that enqueueing fails.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobs, utterances, type DbOrTx } from "@dialect/db";
import { silentLogger, type Logger } from "../context";
import type * as Queue from "../jobs/queue";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { createUtterance, startTask, submitUtterance, uploadUtteranceAudio } from "./index";
import { createTestStudy, expectStep, sessionAtTasks, sineWav } from "./test-support";

const failure = vi.hoisted(() => ({ mode: "throw" as "throw" | "database" }));

vi.mock("../jobs/queue", async (importOriginal) => {
  const original = await importOriginal<typeof Queue>();
  return {
    ...original,
    enqueueJob: async (dbOrTx: DbOrTx) => {
      if (failure.mode === "database") {
        // A real database error: without a savepoint it would abort the whole transaction.
        await dbOrTx.execute(sql`select 1 / 0`);
      }
      throw new Error("the queue is not available");
    },
  };
});

let t: TestServiceContext;

beforeAll(async () => {
  t = await createTestServiceContext();
});
afterAll(async () => {
  await t.cleanup();
});

describe("submitUtterance when enqueueing fails", () => {
  for (const mode of ["throw", "database"] as const) {
    it(`still stores the submission and advances (${mode} failure), and logs the failure`, async () => {
      failure.mode = mode;
      const logged: Array<Record<string, unknown> | string> = [];
      const logger: Logger = { ...silentLogger, error: (entry) => void logged.push(entry) };
      const ctx = { ...t.ctx, logger };

      const study = await createTestStudy(t.ctx.db, {
        settings: { autoQueueAsr: true },
        tasks: [
          { taskKey: "one", title: "One", participantPrompt: "Prompt one." },
          { taskKey: "two", title: "Two", participantPrompt: "Prompt two." },
        ],
      });
      const { session, state } = await sessionAtTasks(ctx, study.slug);
      await startTask(ctx, session, state.task.presentationId);
      const { utteranceId } = await createUtterance(ctx, session, {
        presentationId: state.task.presentationId,
        turnIndex: 0,
      });
      const upload = await uploadUtteranceAudio(ctx, session, { utteranceId, data: sineWav() });

      const next = await submitUtterance(ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId });
      expect(expectStep(next, "tasks").task.title).toBe("Two");
      const [row] = await t.ctx.db.select().from(utterances).where(eq(utterances.id, utteranceId));
      expect(row).toMatchObject({ status: "submitted", acceptedMediaAssetId: upload.mediaAssetId });
      expect(row!.submittedAt).not.toBeNull();
      const queued = (await t.ctx.db.select().from(jobs)).filter((job) => job.idempotencyKey.includes(utteranceId));
      expect(queued).toHaveLength(0);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ jobType: "asr", idempotencyKey: `asr:auto:${utteranceId}` });
    });
  }
});
