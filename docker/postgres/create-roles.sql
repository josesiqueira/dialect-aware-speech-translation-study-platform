-- Least-privilege database roles for the Dialect Translation Study platform.
-- Documented in docs/DEPLOYMENT.md, "Database roles". Tested in
-- packages/db/src/roles.test.ts, which runs this exact file.
--
-- Run it once per database, connected to that database as a superuser (or as a
-- role that may create roles and owns the objects of the database). It is
-- idempotent: running it again repairs ownership and privileges and changes
-- nothing else. It works before the first migration (empty database) and on a
-- database that was migrated earlier by another role.
--
-- Two roles:
--   owner role        owns the schemas, tables, types and functions. Only the
--                     migration command connects as this role
--                     (MIGRATION_DATABASE_URL).
--   application role  used by the web app and the worker (DATABASE_URL). It can
--                     SELECT, INSERT, UPDATE and DELETE rows, and nothing else:
--                     no TRUNCATE, no TRIGGER, no REFERENCES, no ownership, no
--                     superuser. It can therefore not disable a trigger, drop or
--                     alter a table, or set session_replication_role.
--
-- Parameters are session settings. Set them before running the file, for
-- example with docker/postgres/create-roles.sh, or by hand in psql:
--   SELECT set_config('dialect_setup.owner_role', 'dialect_owner', false);
--   SELECT set_config('dialect_setup.app_role', 'dialect_app', false);
--   SELECT set_config('dialect_setup.owner_password', '...', false);
--   SELECT set_config('dialect_setup.app_password', '...', false);
--   \i docker/postgres/create-roles.sql
-- Role names default to dialect_owner and dialect_app. An empty or missing
-- password leaves the password of the role as it is (a new role then has no
-- password and cannot log in with one until it is set, for example with the
-- psql command \password).

DO $roles$
DECLARE
  v_owner text := coalesce(nullif(current_setting('dialect_setup.owner_role', true), ''), 'dialect_owner');
  v_app text := coalesce(nullif(current_setting('dialect_setup.app_role', true), ''), 'dialect_app');
  v_owner_password text := nullif(current_setting('dialect_setup.owner_password', true), '');
  v_app_password text := nullif(current_setting('dialect_setup.app_password', true), '');
  v_database text := current_database();
  v_schema text;
  v_object record;
BEGIN
  IF v_owner = v_app THEN
    RAISE EXCEPTION 'the owner role and the application role must be two different roles';
  END IF;

  -- 1. The roles. Neither is a superuser, and neither can create roles or databases.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_owner) THEN
    EXECUTE format('CREATE ROLE %I', v_owner);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_app) THEN
    EXECUTE format('CREATE ROLE %I', v_app);
  END IF;
  EXECUTE format(
    'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', v_owner);
  EXECUTE format(
    'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', v_app);
  IF v_owner_password IS NOT NULL THEN
    EXECUTE format('ALTER ROLE %I PASSWORD %L', v_owner, v_owner_password);
  END IF;
  IF v_app_password IS NOT NULL THEN
    EXECUTE format('ALTER ROLE %I PASSWORD %L', v_app, v_app_password);
  END IF;

  -- The application role must not be able to act as the owner or as any other role.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = v_app
  ) THEN
    RAISE EXCEPTION 'the application role % is a member of another role, remove the membership first', v_app;
  END IF;

  -- 2. Database and schemas. The owner role may create schemas (the migrator
  --    keeps its own table in the schema "drizzle"). Nobody else may create
  --    objects in the two schemas.
  EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO %I', v_database, v_owner);
  -- TEMPORARY: the test data reset collects ids in a temporary table.
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', v_database, v_app);
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I', v_database, v_app);
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION %I', v_owner);
  EXECUTE format('ALTER SCHEMA public OWNER TO %I', v_owner);
  EXECUTE format('ALTER SCHEMA drizzle OWNER TO %I', v_owner);
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  REVOKE CREATE ON SCHEMA drizzle FROM PUBLIC;
  EXECUTE format('REVOKE CREATE ON SCHEMA public, drizzle FROM %I', v_app);
  EXECUTE format('GRANT USAGE ON SCHEMA public, drizzle TO %I', v_app);

  -- 3. Ownership of everything that already exists in the two schemas.
  --    Objects that belong to an extension are left alone.
  FOR v_object IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND pg_get_userbyid(c.relowner) <> v_owner
      -- A sequence owned by a column follows its table.
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')))
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY c.relkind = 'S', c.relname
  LOOP
    EXECUTE format(
      'ALTER %s %I.%I OWNER TO %I',
      CASE v_object.relkind
        WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE'
      END,
      v_object.nspname, v_object.relname, v_owner);
  END LOOP;

  FOR v_object IN
    SELECT n.nspname, t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND t.typtype IN ('e', 'd', 'r')
      AND pg_get_userbyid(t.typowner) <> v_owner
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', v_object.nspname, v_object.typname, v_owner);
  END LOOP;

  FOR v_object IN
    SELECT p.oid::regprocedure::text AS signature, p.prokind
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND pg_get_userbyid(p.proowner) <> v_owner
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format(
      'ALTER %s %s OWNER TO %I',
      CASE v_object.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
      v_object.signature, v_owner);
  END LOOP;

  -- 4. Privileges of the application role on what exists now. The REVOKE first
  --    makes a second run remove anything that was granted by hand in between.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public, drizzle FROM %I', v_app);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, drizzle FROM %I', v_app);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', v_app);
  EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I', v_app);
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', v_app);
  -- The admin Settings page reads which migrations are applied.
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO %I', v_app);
  FOR v_object IN
    SELECT n.nspname, t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r')
  LOOP
    EXECUTE format('GRANT USAGE ON TYPE %I.%I TO %I', v_object.nspname, v_object.typname, v_app);
  END LOOP;

  -- 5. Default privileges: every table, sequence, type and function that the
  --    owner role creates later (a new migration) gets the same privileges.
  FOREACH v_schema IN ARRAY ARRAY['public'] LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      v_owner, v_schema, v_app);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE ON SEQUENCES TO %I',
      v_owner, v_schema, v_app);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE ON TYPES TO %I',
      v_owner, v_schema, v_app);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I',
      v_owner, v_schema, v_app);
  END LOOP;
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA drizzle GRANT SELECT ON TABLES TO %I', v_owner, v_app);

  RAISE NOTICE 'database %: owner role %, application role %', v_database, v_owner, v_app;
END;
$roles$;
