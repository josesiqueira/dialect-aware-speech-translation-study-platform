// Builds the ServiceContext that every service function in @dialect/research takes.
//
// Usage in a route handler (apiRoute already does this and passes `ctx`):
//   const ctx = getServiceContext(actorLabel);
//   const result = await someService(ctx, input);
//
// One database pool, one storage adapter and one logger exist per process. They are
// cached on globalThis so that Next.js hot reload in development does not open a
// new pool on every code change.
import "server-only";
import { createProviderRegistry, type ProviderRegistry } from "@dialect/ai";
import { createDatabase, type Database, type DatabaseHandle } from "@dialect/db";
import type { Logger, ServiceContext } from "@dialect/research";
import { createStorage, storageConfigFromEnv, type StorageAdapter } from "@dialect/storage";
import { getEnv } from "./env";
import { createLogger } from "./logger";

type ProcessServices = {
  database?: DatabaseHandle;
  // The connection string the pool was opened with, to detect a changed configuration.
  databaseUrl?: string;
  storage?: StorageAdapter;
  logger?: Logger;
  providers?: ProviderRegistry;
};

// Test-only replacements, set with setServiceOverridesForTests().
type Overrides = {
  db?: Database;
  storage?: StorageAdapter;
  providers?: ProviderRegistry;
  logger?: Logger;
  now?: () => Date;
};

const globalStore = globalThis as typeof globalThis & {
  __dialectWebServices?: ProcessServices;
  __dialectWebOverrides?: Overrides;
};

function services(): ProcessServices {
  if (!globalStore.__dialectWebServices) globalStore.__dialectWebServices = {};
  return globalStore.__dialectWebServices;
}

function overrides(): Overrides {
  return globalStore.__dialectWebOverrides ?? {};
}

export function getDb(): Database {
  const override = overrides().db;
  if (override) return override;
  const env = getEnv();
  const store = services();
  if (!store.database || store.databaseUrl !== env.DATABASE_URL) {
    const previous = store.database;
    store.database = createDatabase(env.DATABASE_URL);
    store.databaseUrl = env.DATABASE_URL;
    // An idle client that loses its connection must not crash the process.
    store.database.pool.on("error", (error) => {
      getLogger().error({ err: { name: error.name, message: error.message } }, "database pool error");
    });
    if (previous) void previous.close().catch(() => {});
  }
  return store.database.db;
}

export function getStorage(): StorageAdapter {
  const override = overrides().storage;
  if (override) return override;
  const store = services();
  if (!store.storage) {
    // Validates the app configuration first, then lets the storage package read its own variables.
    getEnv();
    store.storage = createStorage(storageConfigFromEnv(process.env));
  }
  return store.storage;
}

// AI providers. The permanent API key stays in this server process (spec 26).
export function getProviders(): ProviderRegistry {
  const override = overrides().providers;
  if (override) return override;
  const store = services();
  if (!store.providers) {
    const env = getEnv();
    store.providers = createProviderRegistry({
      ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY } : {}),
      allowMock: env.AI_ALLOW_MOCK_PROVIDER,
    });
  }
  return store.providers;
}

export function getLogger(): Logger {
  const override = overrides().logger;
  if (override) return override;
  const store = services();
  if (!store.logger) {
    // The logger must work even when the configuration is invalid, so that the
    // validation error itself can be logged. It reads process.env directly.
    const raw = process.env;
    store.logger = createLogger({
      level: raw.LOG_LEVEL || (raw.NODE_ENV === "test" ? "silent" : "info"),
      secrets: [
        raw.OPENAI_API_KEY,
        raw.ADMIN_PASSWORD,
        raw.ADMIN_SESSION_SECRET,
        raw.S3_SECRET_ACCESS_KEY,
        raw.S3_ACCESS_KEY_ID,
        databasePassword(raw.DATABASE_URL),
      ],
    });
  }
  return store.logger;
}

function databasePassword(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}

// actorLabel: "admin" (or an annotator label) for researcher actions, null for
// participant and system actions.
export function getServiceContext(actorLabel: string | null = null): ServiceContext {
  const env = getEnv();
  return {
    db: getDb(),
    storage: getStorage(),
    providers: getProviders(),
    now: overrides().now ?? (() => new Date()),
    appVersion: env.APP_VERSION,
    gitCommitSha: env.GIT_COMMIT_SHA,
    actorLabel,
    logger: getLogger(),
  };
}

// The current time, honoring the test clock. Use this instead of `new Date()` in
// server helpers whose behavior depends on time (session expiry, rate limits).
export function currentTime(): Date {
  return (overrides().now ?? (() => new Date()))();
}

// Tests: replace the database, storage, logger or clock. Pass {} to remove all replacements.
export function setServiceOverridesForTests(next: Overrides): void {
  globalStore.__dialectWebOverrides = next;
}

// Tests: close and forget the cached pool, storage and logger.
export async function resetProcessServicesForTests(): Promise<void> {
  const store = services();
  const database = store.database;
  globalStore.__dialectWebServices = {};
  globalStore.__dialectWebOverrides = {};
  if (database) await database.close().catch(() => {});
}
