// Test helper for service tests: a ServiceContext backed by a per-file test
// database, in-memory storage, the mock AI provider and a clock the test controls.
import { createProviderRegistry } from "@dialect/ai";
import { createTestDatabase, type TestDatabase } from "@dialect/db/testing";
import { createInMemoryStorage, type InMemoryStorage } from "@dialect/storage";
import { silentLogger, type ServiceContext } from "./context";

export type TestClock = { now: () => Date; advance: (ms: number) => void; set: (date: Date) => void };

export function createTestClock(start = new Date("2026-10-03T12:00:00.000Z")): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    set: (date) => {
      current = date.getTime();
    },
  };
}

export type TestServiceContext = {
  ctx: ServiceContext;
  // The same context with actorLabel "admin", for researcher actions.
  adminCtx: ServiceContext;
  testDb: TestDatabase;
  storage: InMemoryStorage;
  clock: TestClock;
  cleanup: () => Promise<void>;
};

export async function createTestServiceContext(): Promise<TestServiceContext> {
  const testDb = await createTestDatabase();
  const storage = createInMemoryStorage();
  const clock = createTestClock();
  const ctx: ServiceContext = {
    db: testDb.db,
    storage,
    providers: createProviderRegistry({ allowMock: true }),
    now: clock.now,
    appVersion: "test",
    gitCommitSha: null,
    actorLabel: null,
    logger: silentLogger,
  };
  return {
    ctx,
    adminCtx: { ...ctx, actorLabel: "admin" },
    testDb,
    storage,
    clock,
    cleanup: () => testDb.cleanup(),
  };
}
