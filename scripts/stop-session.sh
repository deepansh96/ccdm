#!/bin/zsh
# Usage: ./scripts/stop-session.sh <project_name>
# Reads registry.json to get the screen session name and stops it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="$1"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project_name>"
  exit 1
fi

SCREEN_NAME=$(python3 -c "import json; r=json.load(open('$REGISTRY')); print(r['projects']['$PROJECT']['screen_name'])")

screen -X -S "$SCREEN_NAME" quit 2>/dev/null && echo "Stopped Discord bot session '$SCREEN_NAME'" || echo "No active session '$SCREEN_NAME' found"
