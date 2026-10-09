// Runs the complete end-to-end suite against an isolated environment.
//
//   pnpm test:e2e:isolated                 (the whole suite)
//   pnpm test:e2e:isolated admin-sessions  (arguments go to `playwright test`)
//
// Steps:
//   1. remove what an interrupted earlier run may have left behind;
//   2. build the web and worker images from the current source;
//   3. start a throwaway PostgreSQL (docker-compose.e2e.yml, project dialect-e2e);
//   4. apply the migrations and the database seed with the worker image;
//   5. add the sample TEST sessions from the host (the script refuses
//      NODE_ENV=production, so it cannot run in the image) into data/e2e-media;
//   6. start web and worker and wait until the web app reports ready;
//   7. run Playwright with E2E_BASE_URL pointing at the isolated instance;
//   8. always: remove the containers, the network, the database (it lives in the
//      memory of the PostgreSQL container) and data/e2e-media.
//
// The development database (host port 5546) and the development server (port
// 3100) are never contacted. See README.md, "Testing end to end".
//
// Options through the environment:
//   E2E_WEB_PORT (3210), E2E_PG_PORT (5547), E2E_ADMIN_PASSWORD,
//   E2E_SKIP_BUILD=1   reuse the images of the last build (not for a final run),
//   E2E_KEEP_STACK=1   leave the stack running afterwards, for debugging. Remove
//                      it with: node scripts/e2e/run-isolated.mjs --down
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROJECT = "dialect-e2e";
const COMPOSE_FILE = path.join(ROOT, "docker-compose.e2e.yml");
const MEDIA_DIR = path.join(ROOT, "data", "e2e-media");
// The saved admin sign-in of the Playwright setup project (apps/web/e2e/support/env.ts).
// The Playwright output of the run (traces of failed tests) stays next to it, in
// apps/web/e2e/.isolated/test-results, until the next run.
const AUTH_STATE = path.join(ROOT, "apps", "web", "e2e", ".isolated", "auth", "admin.json");

const webPort = process.env.E2E_WEB_PORT ?? "3210";
const pgPort = process.env.E2E_PG_PORT ?? "5547";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-not-a-secret";
const baseUrl = `http://localhost:${webPort}`;
const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/dialect_study_e2e`;

const composeEnv = {
  ...process.env,
  E2E_WEB_PORT: webPort,
  E2E_PG_PORT: pgPort,
  E2E_MEDIA_DIR: MEDIA_DIR,
  E2E_UID: String(process.getuid?.() ?? 1000),
  E2E_ADMIN_PASSWORD: adminPassword,
};

function log(message) {
  console.log(`\n[e2e] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function mustRun(step, command, args, options) {
  const status = run(command, args, options);
  if (status !== 0) throw new Error(`${step} failed with exit code ${status}`);
}

function compose(args, options = {}) {
  return ["docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], { env: composeEnv, ...options }];
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(Number(port), "127.0.0.1");
  });
}

async function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health/ready`);
      if (response.ok) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = String(error?.cause?.code ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`the web app did not report ready within ${timeoutMs / 1000} s (${last})`);
}

function tearDown() {
  log("Removing the isolated stack");
  // The tools profile is named so that a leftover dbtools container is removed too.
  run(...compose(["--profile", "tools", "down", "--volumes", "--remove-orphans", "--timeout", "15"]));
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  rmSync(AUTH_STATE, { force: true });
}

async function main() {
  const playwrightArgs = process.argv.slice(2);
  if (playwrightArgs[0] === "--down") {
    tearDown();
    return 0;
  }

  let exitCode = 1;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  // The child processes receive the signal as well and stop; this handler only
  // keeps this process alive long enough to remove the stack.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const started = Date.now();
  try {
    log("Removing leftovers of an earlier run, if any");
    tearDown();
    for (const port of [webPort, pgPort]) {
      if (!(await portIsFree(port))) throw new Error(`port ${port} is in use; set E2E_WEB_PORT or E2E_PG_PORT`);
    }
    mkdirSync(MEDIA_DIR, { recursive: true });

    if (process.env.E2E_SKIP_BUILD === "1") {
      log("Skipping the image build (E2E_SKIP_BUILD=1)");
    } else {
      log("Building the web and worker images from the current source");
      mustRun("image build", ...compose(["--profile", "tools", "build", "web", "dbtools"]));
    }

    log("Starting PostgreSQL");
    mustRun("PostgreSQL start", ...compose(["up", "-d", "--wait", "postgres"]));

    log("Applying migrations and the database seed");
    mustRun(
      "migration",
      ...compose(["run", "--rm", "dbtools", "node", "--import", "tsx", "../../packages/db/src/migrate.ts"]),
    );
    mustRun(
      "database seed",
      ...compose(["run", "--rm", "dbtools", "node", "--import", "tsx", "../../packages/db/src/seed/index.ts"]),
    );

    log("Adding the sample TEST sessions (mock provider, generated tones)");
    mustRun("sample session seed", "pnpm", ["exec", "tsx", "scripts/seed-test-sessions.ts", "3"], {
      env: {
        ...process.env,
        NODE_ENV: "development",
        DATABASE_URL: databaseUrl,
        STORAGE_DRIVER: "local",
        LOCAL_STORAGE_ROOT: MEDIA_DIR,
        APP_VERSION: "0.1.0-e2e-seed",
      },
    });

    log("Starting web and worker");
    mustRun("application start", ...compose(["up", "-d", "--no-build", "web", "worker"]));
    await waitForReady(120_000);
    log(`Ready at ${baseUrl} after ${Math.round((Date.now() - started) / 1000)} s`);

    log("Running Playwright");
    exitCode = run("pnpm", ["--filter", "@dialect/web", "exec", "playwright", "test", ...playwrightArgs], {
      env: {
        ...process.env,
        E2E_BASE_URL: baseUrl,
        E2E_ISOLATED: "1",
        E2E_ADMIN_PASSWORD: adminPassword,
      },
    });
    if (exitCode !== 0) {
      log("Playwright failed. Last log lines of web and worker:");
      run(...compose(["logs", "--no-color", "--tail", "15", "web", "worker"]));
    }
  } catch (error) {
    console.error(`\n[e2e] ${error instanceof Error ? error.message : String(error)}`);
    run(...compose(["logs", "--no-color", "--tail", "60"]));
    exitCode = 1;
  } finally {
    if (process.env.E2E_KEEP_STACK === "1" && !interrupted) {
      log(`Stack left running (E2E_KEEP_STACK=1) at ${baseUrl}. Remove it with: node scripts/e2e/run-isolated.mjs --down`);
    } else {
      tearDown();
    }
    log(`Finished in ${Math.round((Date.now() - started) / 1000)} s with exit code ${exitCode}`);
  }
  return interrupted ? 130 : exitCode;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
