#!/bin/zsh
# Usage: ./scripts/retire-pool.sh [--apply]
# Retires the Bot Pool once every project is on the Router. A dry run by
# default: it prints the actions --apply would take and changes nothing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${CCDM_ROUTER_NODE:-node}" "$SCRIPT_DIR/router/retire-pool.js" "$@"
