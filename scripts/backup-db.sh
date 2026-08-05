#!/usr/bin/env bash
#
# Nightly PostgreSQL dump for the self-hosted stack.
#
# Install (as root, from the project directory):
#   chmod +x scripts/backup-db.sh
#   (crontab -l 2>/dev/null; echo "30 2 * * * cd $PWD && ./scripts/backup-db.sh >> backups/backup.log 2>&1") | crontab -
#
# Writes into ./backups, which is bind-mounted into the db container, so
# pg_dump can write directly to the host filesystem without a docker cp.
#
# NOTE: a dump sitting on the same disk as the database survives an application
# bug, not a dead VPS. Copy backups off-box — see the "off-site" note at the end.

set -euo pipefail

cd "$(dirname "$0")/.."

RETENTION_DAYS=14
BACKUP_DIR="./backups"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
ARCHIVE="evokz_ace_${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# Credentials come from .env rather than being repeated here, so a rotated
# password cannot leave the backup job authenticating with a stale one.
# `set -a` exports every assignment; the subshell keeps them out of this script's
# own environment afterwards.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${POSTGRES_USER:?POSTGRES_USER is not set in .env}"
: "${POSTGRES_DB:?POSTGRES_DB is not set in .env}"

echo "[$(date -Is)] dumping ${POSTGRES_DB}..."

# Dump inside the container and gzip on the host. `--clean --if-exists` makes the
# restore idempotent: it drops existing objects first, so replaying a dump onto a
# partially-populated database does not fail on duplicate keys.
#
# Written to a .part file and renamed only on success — an interrupted dump must
# never be left looking like a complete one, because that is exactly the file
# someone reaches for at 3am.
docker compose exec -T db \
  pg_dump --clean --if-exists --no-owner --no-privileges \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  | gzip -9 > "${BACKUP_DIR}/${ARCHIVE}.part"

mv "${BACKUP_DIR}/${ARCHIVE}.part" "${BACKUP_DIR}/${ARCHIVE}"

SIZE="$(du -h "${BACKUP_DIR}/${ARCHIVE}" | cut -f1)"
echo "[$(date -Is)] wrote ${ARCHIVE} (${SIZE})"

# Prune old dumps and any .part files orphaned by an interrupted run.
find "$BACKUP_DIR" -name 'evokz_ace_*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete
find "$BACKUP_DIR" -name '*.part' -mtime +1 -delete

echo "[$(date -Is)] retained: $(find "$BACKUP_DIR" -name 'evokz_ace_*.sql.gz' | wc -l) dump(s)"

# --- Restore -----------------------------------------------------------------
#   gunzip -c backups/evokz_ace_YYYY-MM-DD_HHMMSS.sql.gz \
#     | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
#
# --- Off-site ----------------------------------------------------------------
# Add one line to keep a copy somewhere the VPS cannot take down with it, e.g.
#   rclone copy "${BACKUP_DIR}/${ARCHIVE}" remote:evokz-backups/
