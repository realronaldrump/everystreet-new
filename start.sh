#!/bin/bash
# Improved startup script with proper shutdown handling and environment handling

# Load environment variables from .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Create a trap to catch SIGINT (Ctrl+C) and SIGTERM
trap cleanup EXIT INT TERM

# File to store PIDs
PID_FILE=".service_pids"
> $PID_FILE  # Clear the file

function cleanup() {
  echo "Shutting down services..."
  
  # Read and kill all saved PIDs
  if [ -f "$PID_FILE" ]; then
    while read pid; do
      if kill -0 $pid 2>/dev/null; then
        echo "Stopping process $pid"
        kill -15 $pid
        sleep 1
        # Force kill if still running
        if kill -0 $pid 2>/dev/null; then
          echo "Force stopping $pid"
          kill -9 $pid
        fi
      fi
    done < "$PID_FILE"
    rm "$PID_FILE"
  fi
  
  echo "All services stopped"
  exit 0
}

echo "Starting services..."

# Set default environment variables if not provided
export GUNICORN_WORKERS=${GUNICORN_WORKERS:-2}
export CELERY_WORKER_CONCURRENCY=${CELERY_WORKER_CONCURRENCY:-2}

# Ensure REDIS_URL is constructed properly if not set
if [ -z "$REDIS_URL" ]; then
  if [ -n "$REDISHOST" ] && [ -n "$REDISPASSWORD" ]; then
    export REDIS_URL="redis://default:${REDISPASSWORD}@${REDISHOST}:${REDISPORT:-6379}"
    echo "Constructed REDIS_URL from component variables"
  else
    export REDIS_URL="redis://localhost:6379"
    echo "Using default local Redis URL: $REDIS_URL"
  fi
fi

# Ensure MONGO_URI defaults to local instance if not set
if [ -z "$MONGO_URI" ]; then
  export MONGO_URI="mongodb://localhost:27017/every_street"
  echo "Using default local MongoDB URI: $MONGO_URI"
fi

# Create a non-root user for Celery if we're running as root
if [ "$(id -u)" -eq 0 ]; then
  # Check if celery user exists, create if it doesn't
  if ! id -u celery &>/dev/null; then
    echo "Creating non-root user 'celery'..."
    useradd -m celery
  fi
  CELERY_USER="celery"
  # Ensure permissions on app directory
  chown -R celery:celery .
else
  # Not running as root, use current user
  CELERY_USER=$(id -un)
fi

# Start Gunicorn with the custom config
echo "Starting Gunicorn with $GUNICORN_WORKERS workers..."
gunicorn -c gunicorn_config.py app:app &
echo $! >> $PID_FILE

# Start Celery worker with proper concurrency and non-root user
echo "Starting Celery worker with concurrency=$CELERY_WORKER_CONCURRENCY as user $CELERY_USER..."
if [ "$(id -u)" -eq 0 ]; then
  celery -A celery_app worker --loglevel=info -n worker1@%h --uid=$CELERY_USER --concurrency=$CELERY_WORKER_CONCURRENCY &
else
  celery -A celery_app worker --loglevel=info -n worker1@%h --concurrency=$CELERY_WORKER_CONCURRENCY &
fi
echo $! >> $PID_FILE

echo "Starting Celery beat scheduler..."
if [ "$(id -u)" -eq 0 ]; then
  celery -A celery_app beat --loglevel=info --uid=$CELERY_USER &
else
  celery -A celery_app beat --loglevel=info &
fi
echo $! >> $PID_FILE

echo "All services started. Press Ctrl+C to stop all."
wait