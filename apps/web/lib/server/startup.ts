// Configuration check at server start, called by instrumentation.ts (Node.js runtime only).
//
// Next.js calls `register` once per server instance, before the server handles
// requests. An error thrown there does not stop the standalone server: the
// process stays up and answers every request with 500. So in production this
// function ends the process itself, with exit code 1 and a message that lists
// the variable names and reasons (never values). A container platform then
// shows a failed start instead of a server that looks alive.
//
// In development the message is printed and the server keeps running. The
// names of the wrong variables are in the server log (GET /api/health/ready
// only says that the configuration check failed).
//
// A valid configuration that is risky for the deployment (see
// configurationWarnings in ./env) is printed as a warning and does not stop
// the server.
import "server-only";
import { configurationWarnings, getEnv, type Env } from "./env";

export interface StartupCheckOptions {
  /** Default: process.env.NODE_ENV. */
  nodeEnv?: string;
  /** Default: process.exit. */
  exit?: (code: number) => void;
  /** Default: console.error. */
  log?: (message: string) => void;
  /** Default: getEnv from ./env. Throws when the configuration is invalid. */
  validate?: () => unknown;
  /** Default: console.warn. Receives the configuration warnings. */
  warn?: (message: string) => void;
}

/** Returns true when the configuration is valid. */
export function checkConfigurationAtStartup(options: StartupCheckOptions = {}): boolean {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((message: string) => console.error(message));
  const validate = options.validate ?? getEnv;
  try {
    const env = validate();
    // A valid configuration can still be risky for this deployment: say so loudly.
    if (env && typeof env === "object" && "APP_URL" in env && "TRUST_PROXY" in env) {
      const warn = options.warn ?? ((message: string) => console.warn(message));
      for (const warning of configurationWarnings(env as Env)) {
        warn(`\n*** CONFIGURATION WARNING (${warning.code}) ***\n${warning.message}\n`);
      }
    }
    return true;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    if (nodeEnv === "production") {
      log("The server stops because its configuration is invalid.");
      exit(1);
    }
    return false;
  }
}
