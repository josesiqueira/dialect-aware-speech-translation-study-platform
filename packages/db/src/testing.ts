// Test helper: gives each test file its own empty, fully migrated PostgreSQL database.
// A template database is migrated once per migration set, then copied, which is fast.
// Requires the local Docker Compose Postgres (pnpm db:up).
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { createDatabase, type Database } from "./client";
import { MIGRATIONS_FOLDER, runMigrations } from "./migrate";

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://postgres:postgres@localhost:5546/postgres";

function urlForDatabase(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function migrationSetHash(): string {
  const hash = createHash("sha256");
  for (const file of readdirSync(MIGRATIONS_FOLDER).sort()) {
    if (file.endsWith(".sql")) hash.update(file).update(readFileSync(path.join(MIGRATIONS_FOLDER, file)));
  }
  return hash.digest("hex").slice(0, 12);
}

export type TestDatabase = {
  db: Database;
  pool: pg.Pool;
  url: string;
  name: string;
  cleanup: () => Promise<void>;
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const templateName = `dialect_tpl_${migrationSetHash()}`;
  const name = `dialect_test_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    // Serialize template creation and copying across parallel test processes.
    await admin.query("SELECT pg_advisory_lock(hashtext('dialect_test_template'))");
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [templateName]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${templateName}"`);
      try {
        await runMigrations(urlForDatabase(templateName));
      } catch (error) {
        await admin.query(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
        throw error;
      }
    }
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${templateName}"`);
    await admin.query("SELECT pg_advisory_unlock(hashtext('dialect_test_template'))");
  } finally {
    await admin.end();
  }

  const url = urlForDatabase(name);
  const handle = createDatabase(url, { max: 5 });
  return {
    db: handle.db,
    pool: handle.pool,
    url,
    name,
    cleanup: async () => {
      await handle.close();
      const client = new pg.Client({ connectionString: ADMIN_URL });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
