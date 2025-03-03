#!/bin/bash
# Script for running the application in production on Railway

echo "Starting EveryStreet in production mode..."

# Production deployment with proxy headers and Railway's dynamic port
UVICORN_CMD_ARGS="--proxy-headers --forwarded-allow-ips=*" \
gunicorn app:app \
  -k uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:${PORT:-8080} \
  --workers 4 \
  --worker-connections 150 \
  --keep-alive 5 \
  --max-requests 1000 \
  --max-requests-jitter 50 \
  --graceful-timeout 30 \
  --timeout 60 