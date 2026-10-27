#!/usr/bin/env bash
# Restores a PostgreSQL backup into a scratch database and checks it is usable.
# A backup that has never been restored is a hope, not a backup: run this after
# setting up backups and then at least monthly.
#
# Usage:
#   BACKUP_FILE=mgcleaning-2026-10-27.dump \
#   SCRATCH_DATABASE_URL=postgres://user:pass@host:5432/mgcleaning_restore_check \
#   [PRODUCTION_DATABASE_URL=postgres://...] \
#   scripts/restore-drill.sh
#
# Requires pg_restore and psql (the postgres:17 image has both). The scratch database
# must already exist, must be empty or disposable, and its name must contain
# "restore" or "scratch" so a live database can never be overwritten by mistake.
set -euo pipefail

: "${BACKUP_FILE:?Set BACKUP_FILE to a pg_dump custom-format (.dump) or plain .sql file}"
: "${SCRATCH_DATABASE_URL:?Set SCRATCH_DATABASE_URL to a disposable database}"

database_name="${SCRATCH_DATABASE_URL##*/}"
database_name="${database_name%%\?*}"
case "$database_name" in
  *restore*|*scratch*) ;;
  *) echo "Refusing to restore into '$database_name': the name must contain 'restore' or 'scratch'." >&2; exit 1 ;;
esac
if [ -n "${PRODUCTION_DATABASE_URL:-}" ] && [ "$SCRATCH_DATABASE_URL" = "$PRODUCTION_DATABASE_URL" ]; then
  echo "Refusing to restore: SCRATCH_DATABASE_URL is the production database." >&2
  exit 1
fi
[ -s "$BACKUP_FILE" ] || { echo "Backup file '$BACKUP_FILE' is missing or empty." >&2; exit 1; }

started=$(date +%s)
echo "Restoring $BACKUP_FILE into $database_name …"
case "$BACKUP_FILE" in
  *.sql) psql "$SCRATCH_DATABASE_URL" --set ON_ERROR_STOP=1 --quiet --file "$BACKUP_FILE" ;;
  *) pg_restore --dbname "$SCRATCH_DATABASE_URL" --clean --if-exists --no-owner --no-privileges --exit-on-error "$BACKUP_FILE" ;;
esac

echo "Checking the restored data …"
psql "$SCRATCH_DATABASE_URL" --set ON_ERROR_STOP=1 --no-align --tuples-only --field-separator ' ' <<'SQL'
SELECT 'migrations_applied', count(*) FROM drizzle.__drizzle_migrations;
SELECT 'admin_users', count(*) FROM admin_users;
SELECT 'contact_inquiries', count(*) FROM contact_inquiries;
SELECT 'latest_inquiry_at', coalesce(max(created_at)::text, 'none') FROM contact_inquiries;
SELECT 'blog_posts', count(*) FROM blog_posts;
SELECT 'published_posts', count(*) FROM blog_posts WHERE status = 'published';
SELECT 'media_assets_verified', count(*) FROM media_assets WHERE status = 'verified';
SELECT 'email_outbox_dead_letter', count(*) FROM email_outbox WHERE status = 'dead_letter';
SQL

admins=$(psql "$SCRATCH_DATABASE_URL" --no-align --tuples-only --command "SELECT count(*) FROM admin_users")
if [ "$admins" -lt 1 ]; then
  echo "Restore check failed: no admin accounts in the restored data." >&2
  exit 1
fi
echo "Restore drill passed in $(( $(date +%s) - started ))s. Compare the counts with production, record the result in the runbook log, then drop $database_name."
