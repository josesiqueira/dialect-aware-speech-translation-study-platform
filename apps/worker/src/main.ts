// Entry point of the background worker. Reads the environment (in development
// the `dev` script loads ../../.env, in a container the real environment is used),
// then polls the jobs table until SIGINT or SIGTERM.
import { runWorker } from "@dialect/research";
import { buildWorkerDeps } from "./deps";
import { parseWorkerEnv, secretValues, WorkerEnvError, type WorkerEnv } from "./env";
import { buildHandlers } from "./handlers";
import { createWorkerLogger } from "./logger";
import { startMaintenance } from "./maintenance";

// Upper limit for closing the database pool at exit.
const CLOSE_TIMEOUT_MS = 5_000;

async function main(): Promise<number> {
  let env: WorkerEnv;
  try {
    env = parseWorkerEnv(process.env);
  } catch (error) {
    if (!(error instanceof WorkerEnvError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  const secrets = secretValues(env);
  const logger = createWorkerLogger({ level: env.LOG_LEVEL, secrets });
  const { deps, close } = buildWorkerDeps(env, process.env, logger);
  const handlers = buildHandlers();

  const controller = new AbortController();
  let signalCount = 0;
  const onSignal = (name: string) => {
    signalCount += 1;
    if (signalCount === 1) {
      logger.info({ signal: name }, "shutdown requested, waiting for running jobs");
      controller.abort();
    } else {
      logger.warn({ signal: name }, "second signal, exiting without waiting");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  logger.info(
    {
      workerId: env.WORKER_ID,
      nodeEnv: env.NODE_ENV,
      appVersion: env.APP_VERSION,
      gitCommitSha: env.GIT_COMMIT_SHA,
      storageDriver: deps.ctx.storage.driver,
      providers: deps.providers.listProviders(),
      openaiConfigured: deps.providers.isConfigured("openai"),
      jobTypes: Object.keys(handlers),
    },
    "worker starting",
  );

  startMaintenance(deps.ctx, controller.signal);

  let exitCode = 0;
  try {
    await runWorker({
      deps,
      handlers,
      workerId: env.WORKER_ID,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      lockTimeoutMs: env.WORKER_LOCK_TIMEOUT_MS,
      heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
      shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
      concurrency: env.WORKER_CONCURRENCY,
      secrets,
      signal: controller.signal,
    });
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "worker stopped with an error");
    exitCode = 1;
  }

  // A handler that is still running after the shutdown wait can hold a
  // connection, so closing the pool is bounded too.
  await Promise.race([
    close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref()),
  ]);
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`Worker failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
