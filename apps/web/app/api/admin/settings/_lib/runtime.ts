// Facts about this process for the Settings services: environment, where the
// media storage lives (never credentials) and whether the TEST and DEMO data
// reset is allowed in production.
import "server-only";
import type { corpus } from "@dialect/research";
import { getEnv } from "@/lib/server/env";

// ALLOW_TEST_DATA_RESET=true allows "Delete TEST and DEMO data" in production (spec 116).
export function testDataResetAllowedInProduction(): boolean {
  const value = (process.env.ALLOW_TEST_DATA_RESET ?? "").trim().toLowerCase();
  return value === "true" || value === "1";
}

function storageLocation(): string | null {
  const env = getEnv();
  if (env.STORAGE_DRIVER === "local") return env.LOCAL_STORAGE_ROOT;
  if (!env.S3_BUCKET) return null;
  let host: string | null = null;
  if (env.S3_ENDPOINT) {
    try {
      // Host only: an endpoint URL could carry credentials.
      host = new URL(env.S3_ENDPOINT).host;
    } catch {
      host = null;
    }
  }
  return host ? `bucket ${env.S3_BUCKET} at ${host}` : `bucket ${env.S3_BUCKET}`;
}

export function settingsRuntime(): corpus.SettingsRuntime {
  const env = getEnv();
  return {
    environment: env.NODE_ENV,
    storageLocation: storageLocation(),
    allowTestDataResetInProduction: testDataResetAllowedInProduction(),
  };
}
