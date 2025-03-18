#!/bin/bash
# Improved startup script with proper shutdown handling

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

# Start Gunicorn with the custom config
gunicorn -c gunicorn_config.py app:app &
echo $! >> $PID_FILE

# Start Celery workers and related services
celery -A celery_app worker --loglevel=info -n worker1@%h &
echo $! >> $PID_FILE

celery -A celery_app beat --loglevel=info &
echo $! >> $PID_FILE

celery -A celery_app --broker=$REDIS_URL flower --port=5555 --inspect-timeout=15000 --persistent=True &
echo $! >> $PID_FILE

echo "All services started. Press Ctrl+C to stop all."
wait