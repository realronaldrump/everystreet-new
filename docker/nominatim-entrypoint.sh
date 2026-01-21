#!/bin/sh
set -e

log() {
  printf "[nominatim-entrypoint] %s\n" "$*"
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

# Detect PostgreSQL version and paths
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

# Initialize PostgreSQL if needed
if [ -n "$INITDB_BIN" ] && [ ! -f "${PG_DATA}/PG_VERSION" ]; then
  log "Initializing PostgreSQL data directory"
  chown -R postgres:postgres "${PG_DATA}"
  sudo -u postgres "${INITDB_BIN}" -D "${PG_DATA}"
fi

# Start PostgreSQL
if command -v service >/dev/null 2>&1; then
  log "Starting PostgreSQL"
  service postgresql start || true
fi

# Check for existing PBF file
PBF_PATH=$(find_pbf || true)
if [ -n "$PBF_PATH" ]; then
  export PBF_PATH
  log "Found PBF file: $PBF_PATH"
fi

# Check if data has been imported
if [ -f "$IMPORT_FINISHED" ]; then
  log "Import marker found, Nominatim is ready"
  if [ -z "$PBF_PATH" ]; then
    # Try to find PBF again (it might have been downloaded after container start)
    PBF_PATH=$(find_pbf || true)
    if [ -n "$PBF_PATH" ]; then
      export PBF_PATH
    fi
  fi
  exec /app/start.sh
fi

# No data imported yet - start in "waiting for import" mode
# The app will trigger import via docker exec commands
log "No import marker found - waiting for data import"
log "Use the app's Map Data UI to download and import OSM data"
log "PostgreSQL is running and ready to accept import commands"

# Create a simple health endpoint that returns 503 until data is ready
# Keep the container running so we can exec into it for imports
while true; do
  # Check if import was completed (marker file created by import process)
  if [ -f "$IMPORT_FINISHED" ]; then
    log "Import completed! Starting Nominatim service..."
    PBF_PATH=$(find_pbf || true)
    if [ -n "$PBF_PATH" ]; then
      export PBF_PATH
    fi
    exec /app/start.sh
  fi
  sleep 5
done
