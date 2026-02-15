#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${WATCHTOWER_TOKEN:-}" || "${WATCHTOWER_TOKEN}" == "changeme" ]]; then
  echo "Error: set WATCHTOWER_TOKEN in .env to a strong, non-default value."
  exit 1
fi

# Pull latest published images and run the standard stack without rebuilding.
docker compose -f docker-compose.yml pull web worker
docker compose -f docker-compose.yml up -d --no-build
