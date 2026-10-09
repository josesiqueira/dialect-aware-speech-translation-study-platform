// Helpers shared by the queue and worker tests. Not exported from the package.
import { processingBatches, studies, type BatchConfigurationSnapshot, type Database } from "@dialect/db";
import type { BatchStatus } from "@dialect/domain";
import { createProviderRegistry } from "@dialect/ai";
import type { StorageAdapter } from "@dialect/storage";
import { silentLogger, type Logger, type ServiceContext } from "../context";

const EMPTY_SNAPSHOT: BatchConfigurationSnapshot = {
  selection: {
    mode: ["research"],
    completedSessionsOnly: true,
    verifiedTranscriptsOnly: false,
    excludeFlagged: false,
    excludeExcluded: true,
  },
  transcriptTypes: [],
  runAsr: false,
  asr: null,
  translations: [],
  tts: [],
  sourceLanguage: "fi",
  targetLanguage: "en",
  utteranceIds: [],
};

let counter = 0;

export async function createBatch(db: Database, status: BatchStatus = "running"): Promise<string> {
  counter += 1;
  const [study] = await db
    .insert(studies)
    .values({ slug: `study-${counter}-${Date.now()}`, name: "Test study" })
    .returning();
  const [batch] = await db
    .insert(processingBatches)
    .values({
      studyId: study!.id,
      name: `batch-${counter}`,
      status,
      configurationSnapshotJson: EMPTY_SNAPSHOT,
    })
    .returning();
  return batch!.id;
}

// A clock the test moves by hand.
export function createClock(start = new Date("2026-10-03T12:00:00.000Z")) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export type LogEntry = { level: string; obj: Record<string, unknown> | string; msg?: string };

// Collects log calls so a test can check what was logged.
export function createRecordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at =
    (level: string) =>
    (obj: Record<string, unknown> | string, msg?: string): void => {
      entries.push({ level, obj, msg });
    };
  return { logger: { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") }, entries };
}

export function createTestContext(db: Database, now: () => Date, logger: Logger = silentLogger): ServiceContext {
  return {
    db,
    // The queue never touches storage.
    storage: {} as StorageAdapter,
    providers: createProviderRegistry({ allowMock: true }),
    now,
    appVersion: "test",
    gitCommitSha: null,
    actorLabel: null,
    logger,
  };
}
