// Applies the committed SQL migrations. Never use `drizzle-kit push` against a
// research database (spec 90.4).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client";

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDatabase(connectionString, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

// Migrations run as the role that owns the schema (docs/DEPLOYMENT.md,
// "Database roles"). MIGRATION_DATABASE_URL names that role. DATABASE_URL is the
// fallback, so development with a single role keeps working.
export function migrationDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MIGRATION_DATABASE_URL || env.DATABASE_URL || undefined;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const url = migrationDatabaseUrl();
  if (!url) {
    console.error("Neither MIGRATION_DATABASE_URL nor DATABASE_URL is set");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log("Migrations applied"))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
