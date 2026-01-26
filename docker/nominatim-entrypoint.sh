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

IMPORT_MARKER="${PG_DATA}/import-finished"

has_nominatim_tables() {
  sudo -u postgres psql -d nominatim -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='country_name'" \
    2>/dev/null | tr -d '[:space:]'
}

has_tokenizer_property() {
  # Nominatim requires a tokenizer property to be set after a successful import.
  # Check both possible property tables to guard against partial imports.
  TOKENIZER=$(sudo -u postgres psql -d nominatim -tAc \
    "SELECT value FROM properties WHERE property='tokenizer'" \
    2>/dev/null | tr -d '[:space:]')
  if [ -n "$TOKENIZER" ]; then
    echo "1"
    return
  fi
  TOKENIZER=$(sudo -u postgres psql -d nominatim -tAc \
    "SELECT value FROM nominatim_properties WHERE property='tokenizer'" \
    2>/dev/null | tr -d '[:space:]')
  if [ -n "$TOKENIZER" ]; then
    echo "1"
    return
  fi
  echo "0"
}

# Ensure data directory exists with proper ownership
mkdir -p "$PG_DATA"
chown -R postgres:postgres "$(dirname "$PG_DATA")" 2>/dev/null || true
chown -R postgres:postgres "$PG_DATA" 2>/dev/null || true

# Initialize PostgreSQL if needed
if [ -n "$INITDB_BIN" ] && [ -x "$INITDB_BIN" ] && [ ! -f "${PG_DATA}/PG_VERSION" ]; then
  log "Initializing PostgreSQL $PG_VERSION data directory..."
  sudo -u postgres "$INITDB_BIN" -D "$PG_DATA" 2>&1 || log "initdb warning (may be ok if already initialized)"
fi

# Start PostgreSQL service
log "Starting PostgreSQL service..."
if command -v service >/dev/null 2>&1; then
  service postgresql start 2>&1 || log "PostgreSQL start warning"
elif command -v pg_ctl >/dev/null 2>&1; then
  mkdir -p /var/log/postgresql
  chown postgres:postgres /var/log/postgresql
  sudo -u postgres pg_ctl -D "$PG_DATA" -l /var/log/postgresql/startup.log start 2>&1 || log "pg_ctl start warning"
fi

# Wait for PostgreSQL to accept connections (use postgres database, NOT nominatim)
# The postgres database always exists - nominatim database is created during import
log "Waiting for PostgreSQL to accept connections..."
RETRIES=60
while [ $RETRIES -gt 0 ]; do
  if sudo -u postgres pg_isready -d postgres -q 2>/dev/null; then
    log "PostgreSQL is accepting connections"
    break
  fi
  sleep 2
  RETRIES=$((RETRIES - 1))
done

if [ $RETRIES -eq 0 ]; then
  log "ERROR: PostgreSQL failed to start within timeout"
  exit 1
fi

# Ensure the nominatim role exists (required for import)
# This MUST be done before any import attempt
log "Ensuring required PostgreSQL roles exist..."
ROLE_EXISTS=$(sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='nominatim'" 2>/dev/null || echo "0")
if [ "$ROLE_EXISTS" != "1" ]; then
  log "Creating PostgreSQL role 'nominatim'..."
  sudo -u postgres psql -d postgres -c "CREATE ROLE nominatim WITH SUPERUSER CREATEDB CREATEROLE LOGIN" 2>&1 || log "Role nominatim may already exist"
fi

# Ensure www-data role exists (needed by Nominatim web interface)
WWW_ROLE_EXISTS=$(sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='www-data'" 2>/dev/null || echo "0")
if [ "$WWW_ROLE_EXISTS" != "1" ]; then
  log "Creating PostgreSQL role 'www-data'..."
  sudo -u postgres psql -d postgres -c "CREATE ROLE \"www-data\" WITH LOGIN" 2>&1 || log "Role www-data may already exist"
fi

# Verify roles were created successfully
log "Verifying roles..."
NOMINATIM_OK=$(sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='nominatim'" 2>/dev/null || echo "0")
WWWDATA_OK=$(sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='www-data'" 2>/dev/null || echo "0")
if [ "$NOMINATIM_OK" = "1" ] && [ "$WWWDATA_OK" = "1" ]; then
  log "All required PostgreSQL roles are ready"
else
  log "WARNING: Some roles may not have been created properly"
  log "  nominatim role: $NOMINATIM_OK"
  log "  www-data role: $WWWDATA_OK"
fi

# Check if import has been completed (marker file exists)
if [ -f "$IMPORT_MARKER" ]; then
  log "Import marker found - checking database..."
  DB_EXISTS=$(sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nominatim'" 2>/dev/null || echo "0")
  if [ "$DB_EXISTS" = "1" ]; then
    TABLE_READY=$(has_nominatim_tables || echo "0")
    if [ "$TABLE_READY" = "1" ]; then
      TOKENIZER_OK=$(has_tokenizer_property || echo "0")
      if [ "$TOKENIZER_OK" = "1" ]; then
        log "Nominatim database exists - starting web service"
        exec /app/start.sh
      fi
      log "WARNING: Nominatim database missing tokenizer property. Removing stale marker."
      rm -f "$IMPORT_MARKER"
    fi
    log "WARNING: Nominatim database missing required tables. Removing stale marker."
    rm -f "$IMPORT_MARKER"
  else
    log "WARNING: Import marker exists but database not found. Removing stale marker."
    rm -f "$IMPORT_MARKER"
  fi
fi

# Check if database exists without marker (previous import completed but marker missing)
DB_EXISTS=$(sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nominatim'" 2>/dev/null || echo "0")
if [ "$DB_EXISTS" = "1" ]; then
  TABLE_READY=$(has_nominatim_tables || echo "0")
  if [ "$TABLE_READY" = "1" ]; then
    TOKENIZER_OK=$(has_tokenizer_property || echo "0")
    if [ "$TOKENIZER_OK" = "1" ]; then
      log "Nominatim database found (no marker) - creating marker and starting service"
      touch "$IMPORT_MARKER"
      exec /app/start.sh
    fi
    log "WARNING: Nominatim database missing tokenizer property. Waiting for import."
  fi
  log "WARNING: Nominatim database missing required tables. Waiting for import."
fi

# No import completed yet - keep PostgreSQL running and wait for external import
log "Nominatim database not imported yet."
log "PostgreSQL is running and ready for import."
log "Container will remain up for import command via 'docker exec'."

# Wait for import to complete (detected by marker file or database existence)
while true; do
  # Check if import marker was created (by builders.py after successful import)
  if [ -f "$IMPORT_MARKER" ]; then
    log "Import marker detected! Verifying database..."
    sleep 2
    DB_EXISTS=$(sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nominatim'" 2>/dev/null || echo "0")
    if [ "$DB_EXISTS" = "1" ]; then
      TABLE_READY=$(has_nominatim_tables || echo "0")
      if [ "$TABLE_READY" = "1" ]; then
        log "Import complete - restarting to serve requests..."
        exec /app/start.sh
      fi
      log "Marker found but database tables not ready yet, continuing to wait..."
    else
      log "Marker found but database not ready yet, continuing to wait..."
    fi
  fi

  # Also check if database appeared without marker
  DB_EXISTS=$(sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nominatim'" 2>/dev/null || echo "0")
  if [ "$DB_EXISTS" = "1" ]; then
    TABLE_READY=$(has_nominatim_tables || echo "0")
    if [ "$TABLE_READY" = "1" ]; then
      TOKENIZER_OK=$(has_tokenizer_property || echo "0")
      if [ "$TOKENIZER_OK" = "1" ]; then
        log "Database appeared - creating marker and starting service..."
        touch "$IMPORT_MARKER"
        exec /app/start.sh
      fi
      log "Database appeared but tokenizer property missing, continuing to wait..."
    fi
    log "Database appeared but tables not ready yet, continuing to wait..."
  fi

  sleep 10
done
