#!/usr/bin/env bash
set -euo pipefail

# Pull latest published images and run the standard stack
docker compose -f docker-compose.yml pull web worker

docker compose -f docker-compose.yml up -d
