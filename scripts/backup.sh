#!/usr/bin/env bash
#
# Off-Render backup of the SpamCallStop Postgres database.
# Requires DATABASE_URL in the environment and pg_dump (postgresql-client).
#
#   DATABASE_URL="postgres://..." ./scripts/backup.sh [outdir]
#
# Restore (DESTRUCTIVE — into an empty/target DB):
#   gunzip -c spamcallstop-YYYY-...sql.gz | psql "$DATABASE_URL"
#
set -euo pipefail

OUTDIR="${1:-./backups}"
mkdir -p "$OUTDIR"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set" >&2
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
FILE="$OUTDIR/spamcallstop-$STAMP.sql.gz"

pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$FILE"
echo "Backup written: $FILE"
