#!/bin/sh
set -e

log() {
  printf "[nominatim-wait] %s\n" "$*"
}

find_pbf() {
  for file in /nominatim/data/*.osm.pbf; do
    if [ -f "$file" ]; then
      printf "%s" "$file"
      return 0
    fi
  done
  return 1
}

PG_DATA="/var/lib/postgresql/14/main"
INITDB_BIN="/usr/lib/postgresql/14/bin/initdb"
if [ -d /var/lib/postgresql/16/main ]; then
  PG_DATA="/var/lib/postgresql/16/main"
  INITDB_BIN="/usr/lib/postgresql/16/bin/initdb"
fi
IMPORT_FINISHED="${PG_DATA}/import-finished"

if [ ! -x "$INITDB_BIN" ]; then
  INITDB_BIN=""
fi

if [ -n "$INITDB_BIN" ] && [ ! -f "${PG_DATA}/PG_VERSION" ]; then
  log "Initializing PostgreSQL data directory"
  chown -R postgres:postgres "${PG_DATA}"
  sudo -u postgres "${INITDB_BIN}" -D "${PG_DATA}"
fi

if command -v service >/dev/null 2>&1; then
  log "Starting PostgreSQL"
  service postgresql start || true
fi

log "Waiting for Nominatim import"
while [ ! -f "$IMPORT_FINISHED" ]; do
  if [ -z "$PBF_PATH" ]; then
    PBF_PATH=$(find_pbf || true)
    if [ -n "$PBF_PATH" ]; then
      export PBF_PATH
    fi
  fi
  sleep 10
done

if [ -z "$PBF_PATH" ]; then
  PBF_PATH=$(find_pbf || true)
  if [ -n "$PBF_PATH" ]; then
    export PBF_PATH
  fi
fi

if [ -z "$PBF_PATH" ]; then
  log "No PBF file found; cannot start Nominatim"
  exit 1
fi

log "Import finished, starting Nominatim service"
exec /app/start.sh
