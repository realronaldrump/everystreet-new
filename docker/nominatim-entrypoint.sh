#!/bin/sh
set -e

log() {
  printf "[nominatim-entrypoint] %s\n" "$*"
}

# Detect PostgreSQL version and paths
PG_DATA="/var/lib/postgresql/14/main"
INITDB_BIN="/usr/lib/postgresql/14/bin/initdb"
PG_VERSION="14"

if [ -d /var/lib/postgresql/16/main ] || [ -x /usr/lib/postgresql/16/bin/initdb ]; then
  PG_DATA="/var/lib/postgresql/16/main"
  INITDB_BIN="/usr/lib/postgresql/16/bin/initdb"
  PG_VERSION="16"
fi

if [ ! -x "$INITDB_BIN" ]; then
  INITDB_BIN=""
  log "Warning: initdb not found, database may not initialize properly"
fi

# Ensure data directory exists
mkdir -p "$PG_DATA"

# Initialize PostgreSQL if needed
if [ -n "$INITDB_BIN" ] && [ ! -f "${PG_DATA}/PG_VERSION" ]; then
  log "Initializing PostgreSQL $PG_VERSION data directory..."
  chown -R postgres:postgres "$(dirname "$PG_DATA")"
  chown -R postgres:postgres "$PG_DATA"
  sudo -u postgres "$INITDB_BIN" -D "$PG_DATA" 2>&1 || log "initdb warning (may be ok if already initialized)"
fi

# Ensure proper ownership
if [ -d "$PG_DATA" ]; then
  chown -R postgres:postgres "$PG_DATA" 2>/dev/null || true
fi

# Start PostgreSQL service
log "Starting PostgreSQL service..."
if command -v service >/dev/null 2>&1; then
  service postgresql start 2>&1 || log "PostgreSQL start warning"
elif command -v pg_ctl >/dev/null 2>&1; then
  sudo -u postgres pg_ctl -D "$PG_DATA" -l /var/log/postgresql/startup.log start 2>&1 || log "pg_ctl start warning"
fi

# Wait for PostgreSQL to be ready
log "Waiting for PostgreSQL to become ready..."
RETRIES=30
while [ $RETRIES -gt 0 ]; do
  if sudo -u postgres pg_isready -q 2>/dev/null; then
    log "PostgreSQL is ready"
    break
  fi
  sleep 2
  RETRIES=$((RETRIES - 1))
done

if [ $RETRIES -eq 0 ]; then
  log "Warning: PostgreSQL may not be fully ready"
fi

# Check if nominatim database exists
DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='nominatim'" 2>/dev/null || echo "0")
if [ "$DB_EXISTS" = "1" ]; then
  log "Nominatim database exists - ready to serve requests"
else
  log "Nominatim database not found - will need to import data"
fi

log "Starting Nominatim service..."
if [ "$DB_EXISTS" = "1" ]; then
  exec /app/start.sh
else
  log "Nominatim database not found. Waiting for data import..."
  log "Container will remain up (PostgreSQL is running). Use 'docker exec' to import data."
  tail -f /dev/null
fi
