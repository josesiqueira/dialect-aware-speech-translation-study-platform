#!/bin/sh
# Creates or repairs the two least-privilege database roles by running
# create-roles.sql with psql. Idempotent. See docs/DEPLOYMENT.md, "Database roles".
#
# Environment:
#   DB_ADMIN_URL        required. Connection to the application database as a
#                       superuser, for example
#                       postgresql://postgres:...@host:5432/dialect_study
#   DB_OWNER_ROLE       name of the migration owner role     default dialect_owner
#   DB_APP_ROLE         name of the application role         default dialect_app
#   DB_OWNER_PASSWORD   password to set for the owner role. Empty: unchanged.
#   DB_APP_PASSWORD     password to set for the application role. Empty: unchanged.
#
# The passwords travel to the server inside SQL statements. Run this over a
# trusted connection, and keep statement logging (log_statement) off while it runs.
set -eu

if [ -z "${DB_ADMIN_URL:-}" ]; then
  echo "DB_ADMIN_URL is not set" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

psql "$DB_ADMIN_URL" \
  --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  --set owner_role="${DB_OWNER_ROLE:-dialect_owner}" \
  --set app_role="${DB_APP_ROLE:-dialect_app}" \
  --set owner_password="${DB_OWNER_PASSWORD:-}" \
  --set app_password="${DB_APP_PASSWORD:-}" \
  --set sql_file="$script_dir/create-roles.sql" <<'SQL'
SELECT set_config('dialect_setup.owner_role', :'owner_role', false) \gset ignored_
SELECT set_config('dialect_setup.app_role', :'app_role', false) \gset ignored_
SELECT set_config('dialect_setup.owner_password', :'owner_password', false) \gset ignored_
SELECT set_config('dialect_setup.app_password', :'app_password', false) \gset ignored_
\i :sql_file
SQL

echo "Database roles are set up"
