#!/bin/sh
set -e

log() {
  printf "[nominatim-entrypoint] %s\n" "$*"
}

# Detect PostgreSQL version and paths
PG_DATA="/var/lib/postgresql/14/main"
INITDB_BIN="/usr/lib/postgresql/14/bin/initdb"
if [ -d /var/lib/postgresql/16/main ]; then
  PG_DATA="/var/lib/postgresql/16/main"
  INITDB_BIN="/usr/lib/postgresql/16/bin/initdb"
fi

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

log "Starting Nominatim service"
exec /app/start.sh
