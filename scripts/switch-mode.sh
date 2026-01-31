#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"

case "${mode}" in
  local)
    exec "$(dirname "$0")/local-up.sh"
    ;;
  prod)
    exec "$(dirname "$0")/prod-up.sh"
    ;;
  *)
    echo "Usage: $(basename "$0") {local|prod}"
    exit 1
    ;;
esac
