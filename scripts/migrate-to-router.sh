#!/bin/zsh
# Usage: ./scripts/migrate-to-router.sh [--rollback] <project_name>
# Cuts one project over to the Router (verified, rolled back on failure), or
# returns a migrated project to its pool bot with --rollback.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${CCDM_ROUTER_NODE:-node}" "$SCRIPT_DIR/router/migrate.js" "$@"
