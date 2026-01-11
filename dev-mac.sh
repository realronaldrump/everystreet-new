#!/bin/bash
# dev-mac.sh - Run app locally on Mac (connects to remote database)
#
# By default, a LOCAL Celery worker IS started.
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

export $(grep -v '^#' .env | xargs)

# Cleanup function to kill background processes on exit
cleanup() {
    echo ""
    echo "Shutting down..."
    if [ ! -z "$CELERY_PID" ]; then
        kill $CELERY_PID 2>/dev/null || true
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
# PRE-FLIGHT: Clean up any stale/zombie Celery workers
# ---------------------------------------------------------
echo "Checking for stale Celery workers..."
# We use pkill -f to find any process matching "celery worker"
# We ignore errors (|| true) in case there are none.
pkill -f "celery worker" 2>/dev/null || true
# Wait a moment for them to die
sleep 1
if pgrep -f "celery worker" > /dev/null; then
    echo "Force killing stubborn workers..."
    pkill -9 -f "celery worker" 2>/dev/null || true
fi
echo "Clean slate."
# ---------------------------------------------------------


# Optionally start local Celery worker
if [ "$START_LOCAL_WORKER" = true ]; then
    echo "Starting LOCAL Celery worker..."
    celery -A celery_app.app worker --loglevel=info --pool=solo &
    CELERY_PID=$!
    echo "Celery worker started (PID: $CELERY_PID)"
    # Wait for worker to be ready
    sleep 3
else
    echo "Skipping local Celery worker (tasks processed by production worker)"
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
    echo "  - Local Celery worker: ACTIVE"
else
    echo "  - Local Celery worker: DISABLED (using production/remote)"
fi
echo "  - Press Ctrl+C to stop all services"
echo "========================================"
echo ""

# Wait for either process to exit
wait
