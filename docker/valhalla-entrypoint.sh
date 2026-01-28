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

    # Prefer valhalla_build_config to avoid noisy configure script when no PBFs exist yet.
    if command -v valhalla_build_config >/dev/null 2>&1; then
      log "Generating config with valhalla_build_config..."
      valhalla_build_config \
        --mjolnir-tile-dir "$TILE_DIR" \
        --mjolnir-timezone "$CUSTOM_FILES/timezones.sqlite" \
        --mjolnir-admin "$CUSTOM_FILES/admin_data.sqlite" \
        > "$VALHALLA_CONFIG" 2>/dev/null || log "valhalla_build_config warning"
    fi

    # If config still doesn't exist, fall back to configure script.
    if [ ! -f "$VALHALLA_CONFIG" ] && [ -x /valhalla/scripts/configure_valhalla.sh ]; then
      /valhalla/scripts/configure_valhalla.sh 2>&1 || log "configure_valhalla.sh warning"
    fi
  fi
}

# Remove tile/traffic extract references when archives are not present.
strip_missing_extracts() {
  if [ ! -f "$VALHALLA_CONFIG" ]; then
    return
  fi

  export VALHALLA_CONFIG
  python3 - <<'PY'
import json
import os

config_path = os.environ.get("VALHALLA_CONFIG")
if not config_path or not os.path.exists(config_path):
    raise SystemExit(0)

tile_extract = "/data/valhalla/tiles.tar"
traffic_extract = "/data/valhalla/traffic.tar"

with open(config_path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

mjolnir = data.get("mjolnir") or {}
changed = False

if mjolnir.get("tile_extract") and not os.path.exists(tile_extract):
    mjolnir.pop("tile_extract", None)
    changed = True

if mjolnir.get("traffic_extract") and not os.path.exists(traffic_extract):
    mjolnir.pop("traffic_extract", None)
    changed = True

if changed:
    data["mjolnir"] = mjolnir
    with open(config_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    print("[valhalla-entrypoint] Removed missing tile/traffic extracts from config.")
PY
}

# Start the Valhalla service
start_service() {
  log "Starting Valhalla service..."

  # Prefer running valhalla_service directly to avoid UID/GID checks in run.sh.
  if command -v valhalla_service >/dev/null 2>&1; then
    if [ -f "$VALHALLA_CONFIG" ]; then
      THREADS="${server_threads:-$(nproc)}"
      exec valhalla_service "$VALHALLA_CONFIG" "$THREADS"
    else
      log "ERROR: No valid config file found"
      return 1
    fi
  fi

  # Fall back to bundled run scripts if valhalla_service is unavailable
  if [ -x /valhalla/scripts/run.sh ]; then
    exec /valhalla/scripts/run.sh "$VALHALLA_CONFIG"
  elif [ -x /valhalla/scripts/valhalla_run.sh ]; then
    exec /valhalla/scripts/valhalla_run.sh "$VALHALLA_CONFIG"
  else
    log "ERROR: No Valhalla service executable found"
    return 1
  fi
}

# Generate configuration
generate_config
strip_missing_extracts

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
