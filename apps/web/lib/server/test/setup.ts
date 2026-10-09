// Vitest setup for server tests: a valid base environment and in-memory
// replacements for the request-bound Next.js APIs.
import { afterEach, beforeEach, vi } from "vitest";
import { fakeCookies, fakeHeaders, RedirectSignal, resetRequestScope } from "./request-scope";

vi.mock("next/headers", () => ({
  cookies: async () => fakeCookies,
  headers: async () => fakeHeaders,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  unstable_rethrow: () => {},
}));

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  APP_VERSION: "test-version",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5546/dialect_study",
  ADMIN_PASSWORD: "correct horse battery staple",
  ADMIN_SESSION_SECRET: "test-session-secret-0123456789-abcdefghijklmnop",
  OPENAI_API_KEY: "sk-test-THIS-KEY-MUST-NEVER-APPEAR-1234567890",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_ROOT: "./data/media",
};

const MANAGED_NAMES = [
  ...Object.keys(TEST_ENV),
  "GIT_COMMIT_SHA",
  "LOG_LEVEL",
  "ADMIN_SESSION_TTL_HOURS",
  "PARTICIPANT_SESSION_TTL_HOURS",
  "TRUST_PROXY",
  "AI_ALLOW_MOCK_PROVIDER",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "MAX_AUDIO_UPLOAD_MB",
  "MAX_UTTERANCE_SECONDS",
  "WORKER_ID",
  "WORKER_POLL_INTERVAL_MS",
];

export function applyTestEnv(changes: Record<string, string | undefined> = {}): void {
  const env = process.env as Record<string, string | undefined>;
  for (const name of MANAGED_NAMES) delete env[name];
  Object.assign(env, TEST_ENV);
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
}

beforeEach(async () => {
  applyTestEnv();
  resetRequestScope();
  const { resetEnvCacheForTests } = await import("../env");
  resetEnvCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});
