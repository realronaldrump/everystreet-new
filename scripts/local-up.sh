#!/usr/bin/env bash
set -euo pipefail

# Ensure watchtower doesn't override local images
if docker compose ps -q watchtower >/dev/null 2>&1; then
  docker compose stop watchtower >/dev/null 2>&1 || true
fi

# Use local overrides (bind-mount code + reload)
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
