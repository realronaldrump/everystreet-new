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

# Docker Compose command will be detected below
DOCKER_COMPOSE_CMD=()

# Track Docker-managed services so we can stop them during cleanup
STARTED_DOCKER_SERVICES=()

function docker_compose_available() {
  [ ${#DOCKER_COMPOSE_CMD[@]} -gt 0 ]
}

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
  
  if docker_compose_available && [ ${#STARTED_DOCKER_SERVICES[@]} -gt 0 ]; then
    echo "Stopping Docker services: ${STARTED_DOCKER_SERVICES[*]}"
    "${DOCKER_COMPOSE_CMD[@]}" stop "${STARTED_DOCKER_SERVICES[@]}" >/dev/null
  fi

  echo "All services stopped"
  exit 0
}

echo "Starting services..."

# Attempt to detect Docker Compose support
DOCKER_COMPOSE_CMD=()
if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD=(docker-compose)
fi

function docker_service_running() {
  local service=$1
  docker_compose_available || return 1
  "${DOCKER_COMPOSE_CMD[@]}" ps --services --filter "status=running" |
    grep -q "^${service}$"
}

function ensure_docker_service() {
  local service=$1
  docker_compose_available || return 1

  local was_running=0
  if docker_service_running "$service"; then
    was_running=1
  fi

  echo "Ensuring $service service via Docker Compose..."
  if ! "${DOCKER_COMPOSE_CMD[@]}" up -d "$service"; then
    echo "Failed to start $service with Docker Compose."
    return 1
  fi

  if [ "$was_running" -eq 0 ]; then
    STARTED_DOCKER_SERVICES+=("$service")
  fi

  return 0
}

function is_port_open() {
  local host=$1
  local port=$2
  python3 - <<PY
import socket
import sys

host = "${host}"
port = int("${port}")

s = socket.socket()
s.settimeout(0.5)
try:
    s.connect((host, port))
except Exception:
    sys.exit(1)
else:
    sys.exit(0)
finally:
    s.close()
PY
}

function wait_for_port() {
  local host=$1
  local port=$2
  local attempts=${3:-20}
  local delay=${4:-1}

  for ((i = 1; i <= attempts; i++)); do
    if is_port_open "$host" "$port"; then
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

function ensure_service() {
  local service_name=$1
  local compose_service=$2
  local host=$3
  local port=$4

  if is_port_open "$host" "$port"; then
    echo "$service_name already running on $host:$port"
    return 0
  fi

  if ensure_docker_service "$compose_service"; then
    echo "Waiting for $service_name to become available on $host:$port..."
    if wait_for_port "$host" "$port" 40 1; then
      echo "$service_name is available."
      return 0
    fi
    echo "Timed out waiting for $service_name on $host:$port"
    return 1
  fi

  echo "Unable to automatically start $service_name. Please ensure it is running on $host:$port."
  return 1
}

# Set default environment variables if not provided
export GUNICORN_WORKERS=${GUNICORN_WORKERS:-2}
export CELERY_WORKER_CONCURRENCY=${CELERY_WORKER_CONCURRENCY:-1}
export CELERY_WORKER_POOL=${CELERY_WORKER_POOL:-solo}

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

if ! ensure_service "Redis" "redis" "localhost" 6379; then
  echo "Redis is required to run the application. Exiting."
  exit 1
fi

if ! ensure_service "MongoDB" "mongo" "localhost" 27017; then
  echo "MongoDB is required to run the application. Exiting."
  exit 1
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
echo "Starting Celery worker with concurrency=$CELERY_WORKER_CONCURRENCY (pool=$CELERY_WORKER_POOL) as user $CELERY_USER..."
if [ "$(id -u)" -eq 0 ]; then
  celery -A celery_app worker --loglevel=info -n worker1@%h --uid=$CELERY_USER --pool=$CELERY_WORKER_POOL --concurrency=$CELERY_WORKER_CONCURRENCY &
else
  celery -A celery_app worker --loglevel=info -n worker1@%h --pool=$CELERY_WORKER_POOL --concurrency=$CELERY_WORKER_CONCURRENCY &
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
