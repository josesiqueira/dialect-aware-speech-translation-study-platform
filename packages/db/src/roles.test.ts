// Proves the least-privilege roles of docker/postgres/create-roles.sql
// (docs/DEPLOYMENT.md, "Database roles") with real roles on the test server:
// the application role can do the work of the services, and it cannot switch
// the guards off. The migration owner role can apply migrations.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client";
import { getPgError, isImmutableRecordError } from "./errors";
import { migrationDatabaseUrl, runMigrations } from "./migrate";
import { sessionConsents, sessions, studies, utterances } from "./schema";
import { deleteDemoAndTestData } from "./test-data-reset";
import { createTestDatabase, type TestDatabase } from "./testing";
import { insertSessionWithUtterance, insertStudy, insertTranscriptWithRevision } from "./testing-builders";

const ROLES_SQL = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docker/postgres/create-roles.sql"),
  "utf8",
);
const INSUFFICIENT_PRIVILEGE = "42501";

const suffix = randomBytes(6).toString("hex");
const ownerRole = `dialect_owner_t_${suffix}`;
const appRole = `dialect_app_t_${suffix}`;
const ownerPassword = randomBytes(12).toString("hex");
const appPassword = randomBytes(12).toString("hex");

function urlAs(baseUrl: string, role: string, password: string, database?: string): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  if (database) url.pathname = `/${database}`;
  return url.toString();
}

// Runs the role script the way docker/postgres/create-roles.sh does: the
// parameters are session settings, then the file is executed unchanged.
async function runRoleScript(superuserUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    for (const [name, value] of [
      ["owner_role", ownerRole],
      ["app_role", appRole],
      ["owner_password", ownerPassword],
      ["app_password", appPassword],
    ] as const) {
      await client.query("SELECT set_config($1, $2, false)", [`dialect_setup.${name}`, value]);
    }
    await client.query(ROLES_SQL);
  } finally {
    await client.end();
  }
}

async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return getPgError(error)?.code;
  }
  return "no error";
}

let t: TestDatabase;
let app: { db: Database; pool: pg.Pool; close: () => Promise<void> };
let freshDatabase: string | null = null;
const handles: Array<{ close: () => Promise<void> }> = [];

beforeAll(async () => {
  // A database that was migrated by the superuser, like an existing deployment.
  t = await createTestDatabase();
  await runRoleScript(t.url);
  app = createDatabase(urlAs(t.url, appRole, appPassword), { max: 2 });
  handles.push(app);
});

afterAll(async () => {
  for (const handle of handles) await handle.close();
  await t.cleanup();
  const admin = new pg.Client({ connectionString: urlAs(t.url, new URL(t.url).username, new URL(t.url).password, "postgres") });
  await admin.connect();
  try {
    if (freshDatabase) await admin.query(`DROP DATABASE IF EXISTS "${freshDatabase}" WITH (FORCE)`);
    // The roles are server-wide. Their databases are gone, so nothing depends on them.
    await admin.query(`DROP ROLE IF EXISTS "${appRole}"`);
    await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
  } finally {
    await admin.end();
  }
});

describe("application role", () => {
  it("is not a superuser, owns nothing and has only row privileges", async () => {
    const role = await app.db.execute<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolbypassrls: boolean }>(
      sql`SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false }]);
    const owned = await app.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'drizzle') AND pg_get_userbyid(c.relowner) = current_user`);
    expect(owned.rows[0]?.n).toBe(0);
    const privileges = await app.db.execute<{ privilege_type: string }>(sql`
      SELECT DISTINCT privilege_type FROM information_schema.table_privileges
      WHERE grantee = current_user AND table_schema = 'public' ORDER BY privilege_type`);
    expect(privileges.rows.map((row) => row.privilege_type)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    // Every table of the schema is covered.
    const uncovered = await app.db.execute<{ table_name: string }>(sql`
      SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT (has_table_privilege(current_user, c.oid, 'SELECT') AND has_table_privilege(current_user, c.oid, 'INSERT')
             AND has_table_privilege(current_user, c.oid, 'UPDATE') AND has_table_privilege(current_user, c.oid, 'DELETE'))`);
    expect(uncovered.rows).toEqual([]);
  });

  it("does the ordinary work of the services", async () => {
    // Inserts in every collected-data table through the builders, as the application role.
    const collected = await insertSessionWithUtterance(app.db);
    const [updated] = await app.db
      .update(sessions)
      .set({ status: "completed", completedAt: new Date(), lastActivityAt: new Date() })
      .where(eq(sessions.id, collected.session.id))
      .returning();
    expect(updated?.status).toBe("completed");
    await insertTranscriptWithRevision(app.db, { utteranceId: collected.utterance.id });
    // The admin Settings page reads the applied migrations.
    const migrations = await app.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(migrations.rows[0]?.n).toBeGreaterThanOrEqual(4);
    // A transaction with row locks, as the services use them.
    await app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM sessions WHERE id = ${collected.session.id} FOR UPDATE`);
      await tx.update(studies).set({ name: "Renamed by the application role" }).where(eq(studies.id, collected.study.id));
    });
  });

  it("runs the guarded reset of test data, and the guards still protect research data", async () => {
    const research = await insertSessionWithUtterance(app.db);
    const test = await insertSessionWithUtterance(app.db, {
      studyId: research.study.id,
      protocolVersionId: research.protocol.id,
      session: { mode: "test" },
    });
    const result = await app.db.transaction((tx) => deleteDemoAndTestData(tx, { studyId: research.study.id }));
    expect(result.deleted.sessions).toBe(1);
    expect(await app.db.select().from(sessions).where(eq(sessions.id, test.session.id))).toEqual([]);
    const error = await app.db
      .delete(sessionConsents)
      .where(eq(sessionConsents.id, research.sessionConsent.id))
      .then(() => null, (reason: unknown) => reason);
    expect(isImmutableRecordError(error)).toBe(true);
    expect(await app.db.select().from(utterances).where(eq(utterances.id, research.utterance.id))).toHaveLength(1);
  });

  it("cannot switch the guards off or change the schema", async () => {
    await insertSessionWithUtterance(app.db);
    const run = (statement: string) => codeOf(() => app.db.execute(sql.raw(statement)));
    expect(await run("ALTER TABLE sessions DISABLE TRIGGER dialect_10_guard")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run("ALTER TABLE transcript_revisions DISABLE TRIGGER ALL")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run("TRUNCATE sessions CASCADE")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run("TRUNCATE admin_audit_log")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run("SET session_replication_role = replica")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run("DROP TABLE research_notes")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run("DROP TRIGGER dialect_10_guard ON sessions")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run("ALTER TABLE sessions ADD COLUMN extra text")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run("CREATE TABLE public.shadow (id int)")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await run("CREATE OR REPLACE FUNCTION public.dialect_reset_allowed() RETURNS boolean LANGUAGE sql AS 'SELECT true'"),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await run("CREATE TRIGGER extra BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION public.dialect_set_updated_at()"),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run(`SET ROLE "${ownerRole}"`)).toBe(INSUFFICIENT_PRIVILEGE);
    // The session is still usable and the data is still there.
    expect((await app.db.select().from(sessions)).length).toBeGreaterThan(0);
  });
});

describe("migration owner role", () => {
  it("owns the schema after the script ran on a database migrated by another role", async () => {
    const owner = createDatabase(urlAs(t.url, ownerRole, ownerPassword), { max: 1 });
    handles.push(owner);
    const foreign = await owner.db.execute<{ name: string }>(sql`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'S') AND pg_get_userbyid(c.relowner) <> current_user
      UNION ALL
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> current_user
      UNION ALL
      SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e' AND pg_get_userbyid(t.typowner) <> current_user`);
    expect(foreign.rows).toEqual([]);
    const role = await owner.db.execute<{ rolsuper: boolean }>(sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows).toEqual([{ rolsuper: false }]);
    // Applying the migrations again as the owner changes nothing and does not fail.
    await runMigrations(urlAs(t.url, ownerRole, ownerPassword));
    // A table created by a later migration is covered by the default privileges.
    await owner.db.execute(sql`CREATE TABLE public.later_table (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text)`);
    await app.db.execute(sql`INSERT INTO later_table (note) VALUES ('written by the application role')`);
    expect(await codeOf(() => app.db.execute(sql`TRUNCATE later_table`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await codeOf(() => app.db.execute(sql`DROP TABLE later_table`))).toBe(INSUFFICIENT_PRIVILEGE);
    await owner.db.execute(sql`DROP TABLE public.later_table`);
  });

  it("migrates an empty database, and the script can run again", async () => {
    const adminUrl = urlAs(t.url, new URL(t.url).username, new URL(t.url).password, "postgres");
    freshDatabase = `dialect_roles_${suffix}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${freshDatabase}"`);
    } finally {
      await admin.end();
    }
    const superuserUrl = urlAs(t.url, new URL(t.url).username, new URL(t.url).password, freshDatabase);
    // Roles first, then the migrations as the owner role.
    await runRoleScript(superuserUrl);
    await runMigrations(urlAs(t.url, ownerRole, ownerPassword, freshDatabase));
    await runRoleScript(superuserUrl);

    const fresh = createDatabase(urlAs(t.url, appRole, appPassword, freshDatabase), { max: 1 });
    handles.push(fresh);
    const study = await insertStudy(fresh.db);
    expect(study.status).toBe("active");
    const collected = await insertSessionWithUtterance(fresh.db, { studyId: study.id });
    expect(collected.utterance.status).toBe("submitted");
    expect(await codeOf(() => fresh.db.execute(sql`TRUNCATE studies CASCADE`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await codeOf(() => fresh.db.execute(sql`ALTER TABLE studies DISABLE TRIGGER ALL`))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("migration connection string", () => {
  it("prefers MIGRATION_DATABASE_URL and falls back to DATABASE_URL", () => {
    expect(migrationDatabaseUrl({ MIGRATION_DATABASE_URL: "postgresql://owner@h/db", DATABASE_URL: "postgresql://app@h/db" })).toBe(
      "postgresql://owner@h/db",
    );
    expect(migrationDatabaseUrl({ MIGRATION_DATABASE_URL: "", DATABASE_URL: "postgresql://app@h/db" })).toBe("postgresql://app@h/db");
    expect(migrationDatabaseUrl({ DATABASE_URL: "postgresql://app@h/db" })).toBe("postgresql://app@h/db");
    expect(migrationDatabaseUrl({})).toBeUndefined();
  });
});
