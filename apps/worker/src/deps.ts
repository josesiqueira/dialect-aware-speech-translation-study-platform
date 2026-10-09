// Builds everything the job handlers need from the validated environment.
import { createProviderRegistry, type ProviderRegistry } from "@dialect/ai";
import { createDatabase } from "@dialect/db";
import type { JobHandlerDeps, Logger, ServiceContext } from "@dialect/research";
import { createStorage, storageConfigFromEnv } from "@dialect/storage";
import type { WorkerEnv } from "./env";

// The provider registry sits next to the context until it becomes a field of
// ServiceContext. Handlers receive this object.
export type WorkerDeps = JobHandlerDeps & { ctx: ServiceContext; providers: ProviderRegistry };

export type BuiltWorkerDeps = { deps: WorkerDeps; close: () => Promise<void> };

export function buildWorkerDeps(
  env: WorkerEnv,
  // The raw environment, read by the storage package for its own variables.
  rawEnv: Record<string, string | undefined>,
  logger: Logger,
): BuiltWorkerDeps {
  const storage = createStorage(storageConfigFromEnv(rawEnv));
  // One connection per job slot, plus heartbeat and stale lock release.
  const database = createDatabase(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + 3 });
  // A dropped idle connection must not crash the process; the next query reconnects.
  database.pool.on("error", (error) => {
    logger.error({ error: error.message }, "idle database connection failed");
  });
  const providers = createProviderRegistry({
    ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY } : {}),
    allowMock: env.AI_ALLOW_MOCK_PROVIDER,
  });
  const ctx: ServiceContext = {
    db: database.db,
    storage,
    providers,
    now: () => new Date(),
    appVersion: env.APP_VERSION,
    gitCommitSha: env.GIT_COMMIT_SHA,
    // The worker acts as the system, not as a researcher.
    actorLabel: null,
    logger,
  };
  return { deps: { ctx, providers }, close: database.close };
}
