#!/bin/bash
# dev-mac.sh - Run app locally on Mac (connects to remote database)
#
# By default, a LOCAL ARQ worker IS started.
# Use --no-local-worker flag to disable it (e.g. if relying on production worker).

set -e

# Parse arguments
START_LOCAL_WORKER=true
for arg in "$@"; do
    case $arg in
        --local-worker)
            START_LOCAL_WORKER=true
            shift
            ;;
        --no-local-worker)
            START_LOCAL_WORKER=false
            shift
            ;;
    esac
done

# Load environment
if [ ! -f .env ]; then
    echo "Error: .env file not found!"
    echo "Copy .env.example to .env and fill in your values"
    exit 1
fi

set -a
source .env
set +a

# Use the local Mac PBF even if .env points to the mini PC path.
LOCAL_OSM_PBF="$PWD/everystreet-data/us-9states.osm.pbf"
if [ -f "$LOCAL_OSM_PBF" ]; then
    export OSM_DATA_PATH="$LOCAL_OSM_PBF"
else
    echo "Warning: local OSM PBF not found at $LOCAL_OSM_PBF; using OSM_DATA_PATH from .env"
fi

# Cleanup function to kill background processes on exit
cleanup() {
    echo ""
    echo "Shutting down..."
    if [ ! -z "$ARQ_PID" ]; then
        kill $ARQ_PID 2>/dev/null || true
    fi
    if [ ! -z "$UVICORN_PID" ]; then
        kill $UVICORN_PID 2>/dev/null || true
    fi
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

echo "Starting EveryStreet in development mode..."
echo "Database: $MONGO_URI"
echo ""

# ---------------------------------------------------------
# PRE-FLIGHT: Clean up any stale/zombie ARQ workers
# ---------------------------------------------------------
echo "Checking for stale ARQ workers..."
# We use pkill -f to find any process matching "arq"
# We ignore errors (|| true) in case there are none.
pkill -f "arq " 2>/dev/null || true
# Wait a moment for them to die
sleep 1
if pgrep -f "arq " > /dev/null; then
    echo "Force killing stubborn workers..."
    pkill -9 -f "arq " 2>/dev/null || true
fi
echo "Clean slate."
# ---------------------------------------------------------


# Optionally start local ARQ worker
if [ "$START_LOCAL_WORKER" = true ]; then
    echo "Starting LOCAL ARQ worker..."
    arq tasks.worker.WorkerSettings &
    ARQ_PID=$!
    echo "ARQ worker started (PID: $ARQ_PID)"
    # Wait for worker to be ready
    sleep 3
else
    echo "Skipping local ARQ worker (tasks processed by production worker)"
fi

# Start uvicorn with auto-reload
echo "Starting Uvicorn server..."
uvicorn app:app --host 127.0.0.1 --port 8080 --reload &
UVICORN_PID=$!
echo "Uvicorn started (PID: $UVICORN_PID)"

echo ""
echo "========================================"
echo "EveryStreet is running!"
echo "  - Web UI: http://localhost:8080"
if [ "$START_LOCAL_WORKER" = true ]; then
    echo "  - Local ARQ worker: ACTIVE"
else
    echo "  - Local ARQ worker: DISABLED (using production/remote)"
fi
echo "  - Press Ctrl+C to stop all services"
echo "========================================"
echo ""

# Wait for either process to exit
wait
