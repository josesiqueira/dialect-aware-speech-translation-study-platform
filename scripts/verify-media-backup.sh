#!/usr/bin/env bash
# Verifies a copy of the media store against the database (docs/DEPLOYMENT.md,
# "Restore test"). For every media_assets row that is not deleted, the file must
# exist under the given directory and its SHA-256 and size must equal the row.
#
# Usage:
#   psql "$DATABASE_URL" -At -F '|' -c \
#     "select sha256, size_bytes, storage_key from media_assets where deleted_at is null order by storage_key" \
#     | scripts/verify-media-backup.sh /path/to/media-copy
#
# Input: one line per file, "sha256|size_bytes|storage_key". Exit code 0 when
# every file matches, 1 otherwise. Only storage keys and counts are printed.
set -euo pipefail

root="${1:?usage: verify-media-backup.sh <media directory>  (rows on standard input)}"
if [ ! -d "$root" ]; then
  echo "Not a directory: $root" >&2
  exit 2
fi

total=0
ok=0
missing=0
mismatch=0

while IFS='|' read -r expected_sha expected_size key; do
  [ -n "$key" ] || continue
  total=$((total + 1))
  file="$root/$key"
  if [ ! -f "$file" ]; then
    missing=$((missing + 1))
    echo "MISSING   $key"
    continue
  fi
  actual_sha="$(sha256sum "$file" | cut -d' ' -f1)"
  actual_size="$(stat -c %s "$file")"
  if [ "$actual_sha" = "$expected_sha" ] && [ "$actual_size" = "$expected_size" ]; then
    ok=$((ok + 1))
  else
    mismatch=$((mismatch + 1))
    echo "MISMATCH  $key"
  fi
done

echo "media rows: $total, verified: $ok, missing: $missing, mismatch: $mismatch"
[ "$total" -gt 0 ] || echo "warning: no rows were given on standard input" >&2
[ "$missing" -eq 0 ] && [ "$mismatch" -eq 0 ]
