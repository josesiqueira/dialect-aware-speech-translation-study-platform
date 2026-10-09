// Adds the sample TEST sessions to the development database (spec 91).
// Run from the repository root, after the database seed:
//   pnpm db:seed            (runs the database seed and then this script)
//   pnpm exec tsx --env-file-if-exists=.env scripts/seed-test-sessions.ts [count]
//
// It uses the real storage adapter from the environment, so the sample audio is
// stored where the app reads it, and the mock AI provider, so no model is
// called. Safe to run more than once: existing sample sessions are left alone.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderRegistry } from "../packages/ai/src/index";
import { createDatabase } from "../packages/db/src/client";
import type { ServiceContext } from "../packages/research/src/context";
import { seedSampleTestSessions } from "../packages/research/src/seed-samples/index";
import { createStorage, storageConfigFromEnv } from "../packages/storage/src/index";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadRootEnv(): void {
  if (process.env.DATABASE_URL) return;
  const file = path.join(ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

const consoleLogger = {
  info: () => {},
  debug: () => {},
  warn: (obj: unknown, msg?: string) => console.warn(msg ?? obj),
  error: (obj: unknown, msg?: string) => console.error(msg ?? obj),
};

async function main(): Promise<void> {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("Sample TEST sessions are for development. This script does not run with NODE_ENV=production.");
    process.exit(1);
  }
  const countArgument = process.argv[2];
  const count = countArgument === undefined ? 3 : Number(countArgument);
  if (!Number.isInteger(count) || count < 0 || count > 20) {
    console.error("The count must be a whole number between 0 and 20.");
    process.exit(1);
  }

  const handle = createDatabase(url, { max: 2 });
  try {
    const ctx: ServiceContext = {
      db: handle.db,
      storage: createStorage(storageConfigFromEnv(process.env)),
      // No API key on purpose: the sample outputs come from the mock provider only.
      providers: createProviderRegistry({ allowMock: true }),
      now: () => new Date(),
      appVersion: process.env.APP_VERSION || "development-seed",
      gitCommitSha: process.env.GIT_COMMIT_SHA || null,
      actorLabel: "seed",
      logger: consoleLogger,
    };
    const result = await seedSampleTestSessions(ctx, { count });
    if (result.created.length === 0) {
      console.log(`Sample TEST sessions: nothing to do, ${result.existing} already exist`);
    } else {
      console.log(`Sample TEST sessions: created ${result.created.length} (${result.existing} already existed)`);
      for (const session of result.created) {
        console.log(
          `  ${session.participantCode}  mode test  ${session.utterances} recordings, ` +
            `${session.humanTranscripts} human transcripts, ${session.translations} translations, ${session.syntheses} synthesized files (mock provider)`,
        );
      }
    }
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
