#!/bin/zsh
# Usage: ./scripts/migrate-to-router.sh [--resume] <project_name>
#        ./scripts/migrate-to-router.sh --rollback <project_name>
# Cuts one project over to the Router (verified, rolled back on failure), or
# explains with --rollback that no pool bot remains to return to. --resume
# continues the project's saved conversation when one is found, else starts fresh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${CCDM_ROUTER_NODE:-node}" "$SCRIPT_DIR/router/migrate.js" "$@"
