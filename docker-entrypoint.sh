#!/bin/bash

set -e

# Wait for Redis to be ready
echo "Waiting for Redis to be ready..."
until [ "$(redis-cli -u ${REDIS_URL} ping 2>/dev/null)" = "PONG" ]; do
  echo "Redis not yet ready, retrying..."
  sleep 1
done
echo "Redis is ready!"

# Run the command passed to docker run
exec "$@"