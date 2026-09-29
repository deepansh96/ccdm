#!/bin/zsh
# Usage: ./scripts/migrate-to-router.sh [--rollback] <project_name>
# Cuts one project over to the Router (verified, rolled back on failure), or
# explains with --rollback that no pool bot remains to return to.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${CCDM_ROUTER_NODE:-node}" "$SCRIPT_DIR/router/migrate.js" "$@"
