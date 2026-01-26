#!/bin/sh
set -e

log() {
  printf "[valhalla-entrypoint] %s\n" "$*"
}

CUSTOM_FILES="/custom_files"
VALHALLA_CONFIG="$CUSTOM_FILES/valhalla.json"
TILE_DIR="$CUSTOM_FILES/valhalla_tiles"

# Ensure directories exist
mkdir -p "$CUSTOM_FILES"
mkdir -p "$TILE_DIR"

# Function to count tiles (handles empty directory gracefully)
count_tiles() {
  find "$TILE_DIR" -name "*.gph" 2>/dev/null | wc -l | tr -d ' '
}

# Generate default config if it doesn't exist
generate_config() {
  if [ ! -f "$VALHALLA_CONFIG" ]; then
    log "Generating default Valhalla configuration..."

    # Try using the configure script first
    if [ -x /valhalla/scripts/configure_valhalla.sh ]; then
      /valhalla/scripts/configure_valhalla.sh 2>&1 || log "configure_valhalla.sh warning"
    fi

    # If config still doesn't exist, generate manually
    if [ ! -f "$VALHALLA_CONFIG" ]; then
      log "Generating config with valhalla_build_config..."
      if command -v valhalla_build_config >/dev/null 2>&1; then
        valhalla_build_config \
          --mjolnir-tile-dir "$TILE_DIR" \
          --mjolnir-timezone "$CUSTOM_FILES/timezones.sqlite" \
          --mjolnir-admin "$CUSTOM_FILES/admin_data.sqlite" \
          > "$VALHALLA_CONFIG" 2>/dev/null || log "valhalla_build_config warning"
      fi
    fi
  fi
}

# Start the Valhalla service
start_service() {
  log "Starting Valhalla service..."

  # Try different run scripts depending on container version
  if [ -x /valhalla/scripts/run.sh ]; then
    exec /valhalla/scripts/run.sh "$VALHALLA_CONFIG"
  elif [ -x /valhalla/scripts/valhalla_run.sh ]; then
    exec /valhalla/scripts/valhalla_run.sh "$VALHALLA_CONFIG"
  elif command -v valhalla_service >/dev/null 2>&1; then
    # Run valhalla_service directly with config
    if [ -f "$VALHALLA_CONFIG" ]; then
      exec valhalla_service "$VALHALLA_CONFIG"
    else
      log "ERROR: No valid config file found"
      return 1
    fi
  else
    log "ERROR: No Valhalla service executable found"
    return 1
  fi
}

# Generate configuration
generate_config

# Check for existing tiles
TILE_COUNT=$(count_tiles)

if [ "$TILE_COUNT" -gt 0 ]; then
  log "Found $TILE_COUNT routing tiles - ready to serve requests"
  start_service
else
  log "No routing tiles found. Waiting for tile build..."
  log "Container is ready. Use 'docker exec' to run: valhalla_build_tiles -c $VALHALLA_CONFIG <pbf_file>"

  # Keep container running and wait for tiles to be built
  while true; do
    TILE_COUNT=$(count_tiles)
    if [ "$TILE_COUNT" -gt 0 ]; then
      log "Tiles detected ($TILE_COUNT found)! Starting service..."
      start_service
      # If start_service returns (shouldn't with exec), exit
      exit 0
    fi
    sleep 10
  done
fi
