#!/bin/bash
# dev-mac.sh - Run app locally on Mac (connects to remote database)

set -e

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

# Start Celery worker in background (--pool=solo for macOS compatibility)
echo "Starting Celery worker..."
celery -A celery_app.app worker --loglevel=info --pool=solo &
CELERY_PID=$!
echo "Celery worker started (PID: $CELERY_PID)"

# Give Celery a moment to initialize
sleep 2

# Start uvicorn with auto-reload
echo "Starting Uvicorn server..."
uvicorn app:app --host 127.0.0.1 --port 8080 --reload &
UVICORN_PID=$!
echo "Uvicorn started (PID: $UVICORN_PID)"

echo ""
echo "========================================"
echo "EveryStreet is running!"
echo "  - Web UI: http://localhost:8080"
echo "  - Celery worker processing background tasks"
echo "  - Press Ctrl+C to stop all services"
echo "========================================"
echo ""

# Wait for either process to exit
wait