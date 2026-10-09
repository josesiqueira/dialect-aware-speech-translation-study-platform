// Shared setup for server tests that need PostgreSQL: one migrated database per test
// file, in-memory storage, a captured log and a clock the test can move.
import { afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDatabase, type TestDatabase } from "@dialect/db/testing";
import { InMemoryStorage } from "@dialect/storage";
import { resetProcessServicesForTests, setServiceOverridesForTests } from "../context";
import { createLogger } from "../logger";
import { TEST_ENV } from "./setup";

export type ServerTestHarness = {
  readonly database: TestDatabase;
  readonly storage: InMemoryStorage;
  // Serialized log lines written during the current test.
  readonly logLines: string[];
  // The time that ctx.now() and currentTime() return.
  now: Date;
  advanceSeconds(seconds: number): void;
};

export function setupServerTestHarness(): ServerTestHarness {
  let database: TestDatabase;
  const state = {
    storage: new InMemoryStorage(),
    logLines: [] as string[],
    now: new Date("2026-10-03T09:00:00.000Z"),
  };

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await resetProcessServicesForTests();
    await database?.cleanup();
  });

  beforeEach(() => {
    state.storage = new InMemoryStorage();
    state.logLines.length = 0;
    state.now = new Date();
    setServiceOverridesForTests({
      db: database.db,
      storage: state.storage,
      now: () => state.now,
      logger: createLogger({
        level: "debug",
        secrets: [TEST_ENV.OPENAI_API_KEY, TEST_ENV.ADMIN_PASSWORD, TEST_ENV.ADMIN_SESSION_SECRET],
        write: (line) => state.logLines.push(line),
      }),
    });
  });

  return {
    get database() {
      return database;
    },
    get storage() {
      return state.storage;
    },
    get logLines() {
      return state.logLines;
    },
    get now() {
      return state.now;
    },
    set now(value: Date) {
      state.now = value;
    },
    advanceSeconds(seconds: number) {
      state.now = new Date(state.now.getTime() + seconds * 1000);
    },
  };
}

export function jsonRequest(
  url: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; sameOrigin?: boolean } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  // By default the request looks like one sent by a page of the app itself.
  if (options.sameOrigin !== false && !headers.has("origin")) headers.set("origin", new URL(url).origin);
  return new Request(url, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export const noParams = { params: Promise.resolve({}) } as { params: Promise<Record<string, never>> };
