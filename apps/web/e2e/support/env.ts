// Where the end-to-end tests run and how they sign in.
//
//   E2E_BASE_URL        address of the running app (default: the development server)
//   E2E_ISOLATED        "1" when the app is the isolated stack of docker-compose.e2e.yml
//   E2E_ADMIN_PASSWORD  admin password of that app; without it the password is
//                       read from the root .env file (the development server)
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "../../../..");
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
export const ISOLATED = process.env.E2E_ISOLATED === "1";

/**
 * Files of an isolated run: the saved admin sign-in and the Playwright output
 * (traces, downloads). The directory has its own .gitignore. It is apart from
 * apps/web/test-results on purpose: that directory is emptied by every other
 * Playwright run in this checkout, for example a colleague's `pnpm test:e2e`
 * against the development server while the isolated run is in progress.
 */
export const ISOLATED_DIR = path.resolve(__dirname, "../.isolated");
/** Saved by e2e/auth.setup.ts, used by the admin project. */
export const ADMIN_STORAGE_STATE = path.join(ISOLATED_DIR, "auth", "admin.json");
export const ISOLATED_OUTPUT_DIR = path.join(ISOLATED_DIR, "test-results");

export function adminPassword(): string {
  const fromEnvironment = process.env.E2E_ADMIN_PASSWORD;
  if (fromEnvironment) return fromEnvironment;
  const file = path.join(ROOT, ".env");
  const line = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .find((entry) => entry.startsWith("ADMIN_PASSWORD="))
    : undefined;
  if (!line) throw new Error("Set E2E_ADMIN_PASSWORD, or ADMIN_PASSWORD in the root .env file.");
  return line
    .slice("ADMIN_PASSWORD=".length)
    .trim()
    .replace(/^["']|["']$/g, "");
}
