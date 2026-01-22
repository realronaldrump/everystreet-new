#!/bin/sh
set -e

log() {
  printf "[valhalla-entrypoint] %s\n" "$*"
}

# Generate default config if it doesn't exist
if [ ! -f /custom_files/valhalla.json ]; then
  log "Generating default Valhalla configuration"
  if [ -x /valhalla/scripts/configure_valhalla.sh ]; then
    /valhalla/scripts/configure_valhalla.sh || true
  fi
fi

log "Starting Valhalla service"
if [ -x /valhalla/scripts/run.sh ]; then
  exec /valhalla/scripts/run.sh
fi
if [ -x /valhalla/scripts/valhalla_run.sh ]; then
  exec /valhalla/scripts/valhalla_run.sh
fi
exec /valhalla/scripts/valhalla_service
