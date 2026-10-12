#!/bin/sh
# Nightly backup of the live trading database (the tp-mongo container).
#   - every collection except candles: those are ~98% of the size and the feeds
#     and backfill rebuild them; every money record is included
#   - written OUTSIDE the git repo, so a backup can never be committed by accident
#   - kept KEEP_DAYS days; this script deletes only its own older backup files
#   - the password never appears on the command line: it is read from the
#     container's own environment, inside the container
set -eu
CONTAINER="${CONTAINER:-tp-mongo}"
DB="${DB:-trading_platform}"
DIR="${BACKUP_DIR:-/root/mongo-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$DIR"
F="$DIR/$DB-$(date -u +%Y%m%d-%H%M%S).archive.gz"
trap 'rm -f "$F.part"' EXIT

docker exec "$CONTAINER" sh -c 'exec mongodump --quiet \
  --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin --db "$1" --excludeCollection candles --archive --gzip' _ "$DB" > "$F.part"
mv "$F.part" "$F"

find "$DIR" -name "$DB-*.archive.gz" -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) ok $(du -h "$F" | cut -f1) $F" >> "$DIR/backup.log"
