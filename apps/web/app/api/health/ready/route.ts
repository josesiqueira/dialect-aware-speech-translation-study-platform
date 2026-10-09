// GET /api/health/ready (spec 113): can this instance serve requests?
// Checks: required configuration present, database reachable, storage accessible.
// Returns 200 when every check passes, otherwise 503.
//
// The endpoint is public, so the body says only pass or fail per check, plus the
// number of configuration warnings. It never names an environment variable and
// never contains values, hosts, paths or keys. The names of invalid variables,
// the warning texts and the error details go to the server log, where the
// operator reads them. No paid provider API is called.
import { sql } from "drizzle-orm";
import { getDb, getLogger, getStorage } from "@/lib/server/context";
import { configurationWarnings, EnvValidationError, getEnv } from "@/lib/server/env";

export const dynamic = "force-dynamic";

type Check = { ok: boolean };

const CHECK_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function logFailure(check: string, error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
    const code = (cause ?? error) as { code?: unknown };
    getLogger().warn(
      {
        check,
        reason: message.startsWith("Failed query") ? "database query failed" : message,
        ...(typeof code?.code === "string" ? { code: code.code } : {}),
      },
      "readiness check failed",
    );
  } catch {
    // The logger must not turn a readiness answer into an error.
  }
}

// The same problem is logged at most once a minute: a probe calls this every few seconds.
const LOG_REPEAT_MS = 60_000;
const lastLogged = new Map<string, number>();

function logOccasionally(key: string, log: () => void): void {
  const now = Date.now();
  if (now - (lastLogged.get(key) ?? 0) < LOG_REPEAT_MS) return;
  lastLogged.set(key, now);
  try {
    log();
  } catch {
    // The logger must not turn a readiness answer into an error.
  }
}

function checkConfiguration(): { check: Check; warnings: number } {
  try {
    const warnings = configurationWarnings(getEnv());
    for (const warning of warnings) {
      logOccasionally(`warning:${warning.code}`, () =>
        getLogger().warn({ check: "configuration", warning: warning.code }, warning.message),
      );
    }
    return { check: { ok: true }, warnings: warnings.length };
  } catch (error) {
    // Variable names only, never values, and only in the server log.
    const invalid = error instanceof EnvValidationError ? [...new Set(error.issues.map((issue) => issue.variable))] : [];
    logOccasionally(`invalid:${invalid.join(",")}`, () =>
      getLogger().error(
        { check: "configuration", invalid },
        invalid.length > 0
          ? "readiness check failed: missing or invalid environment variables"
          : "readiness check failed: the configuration could not be read",
      ),
    );
    return { check: { ok: false }, warnings: 0 };
  }
}

async function checkDatabase(): Promise<Check> {
  try {
    await withTimeout(getDb().execute(sql`select 1`), "database check");
    return { ok: true };
  } catch (error) {
    logFailure("database", error);
    return { ok: false };
  }
}

async function checkStorage(): Promise<Check> {
  try {
    const result = await withTimeout(getStorage().healthCheck(), "storage check");
    if (result.ok) return { ok: true };
    logFailure("storage", result.detail ?? "health check reported not ok");
    return { ok: false };
  } catch (error) {
    logFailure("storage", error);
    return { ok: false };
  }
}

export async function GET(): Promise<Response> {
  const { check: configuration, warnings } = checkConfiguration();
  // Not checked while the configuration is invalid.
  const skipped: Check = { ok: false };
  const [database, storage] = configuration.ok
    ? await Promise.all([checkDatabase(), checkStorage()])
    : [skipped, skipped];

  const ready = configuration.ok && database.ok && storage.ok;
  return Response.json(
    {
      status: ready ? "ready" : "not_ready",
      version: process.env.APP_VERSION || "dev",
      checks: { configuration, database, storage },
      // Non-fatal configuration warnings. The texts are in the server log.
      warnings,
    },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
