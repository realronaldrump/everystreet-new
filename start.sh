#!/bin/bash
# Improved startup script with proper shutdown handling and environment handling

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
export FLOWER_PORT=${PORT:-5555}

# Ensure REDIS_URL is constructed properly if not set
if [ -z "$REDIS_URL" ]; then
  if [ -n "$REDISHOST" ] && [ -n "$REDISPASSWORD" ]; then
    export REDIS_URL="redis://default:${REDISPASSWORD}@${REDISHOST}:${REDISPORT:-6379}"
    echo "Constructed REDIS_URL from component variables"
  else
    echo "WARNING: REDIS_URL not set and cannot be constructed!"
  fi
fi

# Start Gunicorn with the custom config
echo "Starting Gunicorn with $GUNICORN_WORKERS workers..."
gunicorn -c gunicorn_config.py app:app &
echo $! >> $PID_FILE

# Start Celery worker with proper concurrency
echo "Starting Celery worker with concurrency=$CELERY_WORKER_CONCURRENCY..."
celery -A celery_app worker --loglevel=info -n worker1@%h --concurrency=$CELERY_WORKER_CONCURRENCY &
echo $! >> $PID_FILE

echo "Starting Celery beat scheduler..."
celery -A celery_app beat --loglevel=info &
echo $! >> $PID_FILE

# Start Flower on the correct port
echo "Starting Flower on port $FLOWER_PORT..."
celery -A celery_app --broker="$REDIS_URL" flower --port="$FLOWER_PORT" --inspect-timeout=15000 --persistent=True &
echo $! >> $PID_FILE

echo "All services started. Press Ctrl+C to stop all."
wait