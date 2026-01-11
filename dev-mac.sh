#!/bin/bash
# dev-mac.sh - Run app locally on Mac (connects to remote database)
#
# By default, NO local Celery worker is started. Background tasks are
# processed by the 24/7 production worker on the mini PC.
#
# Use --local-worker flag to start a local Celery worker (not recommended
# as it will compete with the production worker for tasks).

set -e

# Parse arguments
START_LOCAL_WORKER=false
for arg in "$@"; do
    case $arg in
        --local-worker)
            START_LOCAL_WORKER=true
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

echo "Starting EveryStreet in development mode..."
echo "Database: $MONGO_URI"
echo ""

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

# Optionally start local Celery worker
if [ "$START_LOCAL_WORKER" = true ]; then
    echo "Starting LOCAL Celery worker (--local-worker flag enabled)..."
    echo "WARNING: This will compete with the production worker for tasks!"
    celery -A celery_app.app worker --loglevel=info --pool=solo &
    CELERY_PID=$!
    echo "Celery worker started (PID: $CELERY_PID)"
    sleep 2
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
    echo "  - Local Celery worker processing tasks"
else
    echo "  - Background tasks → production worker (mini PC)"
fi
echo "  - Press Ctrl+C to stop all services"
echo "========================================"
echo ""

# Wait for either process to exit
wait
