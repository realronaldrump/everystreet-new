#!/bin/sh
set -e

log() {
  printf "[valhalla-entrypoint] %s\n" "$*"
}

tiles_ready() {
  # Check for tiles directory with actual tile files, or a tiles archive
  if [ -f /custom_files/valhalla_tiles.tar ]; then
    return 0
  fi
  if [ -d /custom_files/valhalla_tiles ]; then
    # Check if directory has any .gph files (graph tiles)
    find /custom_files/valhalla_tiles -name "*.gph" -type f 2>/dev/null | head -1 | grep -q .
    return $?
  fi
  return 1
}

# Generate default config if it doesn't exist
if [ ! -f /custom_files/valhalla.json ]; then
  log "Generating default Valhalla configuration"
  if [ -x /valhalla/scripts/configure_valhalla.sh ]; then
    /valhalla/scripts/configure_valhalla.sh || true
  fi
fi

# Check if tiles are already ready
if tiles_ready; then
  log "Tiles detected, starting Valhalla service"
  if [ -x /valhalla/scripts/run.sh ]; then
    exec /valhalla/scripts/run.sh
  fi
  if [ -x /valhalla/scripts/valhalla_run.sh ]; then
    exec /valhalla/scripts/valhalla_run.sh
  fi
  exec /valhalla/scripts/valhalla_service
fi

# No tiles yet - wait for tile build to complete
log "No tiles found - waiting for tile build"
log "Use the app's Map Data UI to download OSM data and build routing tiles"
log "Container is running and ready to accept build commands"

# Keep container running and check for tiles periodically
while true; do
  if tiles_ready; then
    log "Tiles ready! Starting Valhalla service..."
    if [ -x /valhalla/scripts/run.sh ]; then
      exec /valhalla/scripts/run.sh
    fi
    if [ -x /valhalla/scripts/valhalla_run.sh ]; then
      exec /valhalla/scripts/valhalla_run.sh
    fi
    exec /valhalla/scripts/valhalla_service
  fi
  sleep 5
done
