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

# Start uvicorn with auto-reload
uvicorn app:app --host 127.0.0.1 --port 8080 --reload