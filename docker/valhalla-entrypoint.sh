#!/bin/sh
set -e

log() {
  printf "[valhalla-wait] %s\n" "$*"
}

tiles_ready() {
  [ -d /custom_files/valhalla_tiles ] || [ -f /custom_files/valhalla_tiles.tar ]
}

log "Waiting for Valhalla tiles"
while ! tiles_ready; do
  sleep 10
done

log "Tiles detected, starting Valhalla service"
if [ -x /valhalla/scripts/run.sh ]; then
  exec /valhalla/scripts/run.sh
fi
if [ -x /valhalla/scripts/valhalla_run.sh ]; then
  exec /valhalla/scripts/valhalla_run.sh
fi

exec /valhalla/scripts/valhalla_service
