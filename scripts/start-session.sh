#!/bin/zsh
# Usage: ./scripts/start-session.sh <project_name>
# Reads registry.json to get project config and starts a Claude Code Discord session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="$1"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project_name>"
  exit 1
fi

# Read project config from registry
PATH_DIR=$(python3 -c "import json,os; r=json.load(open('$REGISTRY')); p=r['projects']['$PROJECT']; print(os.path.expanduser(p['path']))")
STATE_DIR=$(python3 -c "import json,os; r=json.load(open('$REGISTRY')); p=r['projects']['$PROJECT']; print(os.path.expanduser(p['state_dir']))")
SCREEN_NAME=$(python3 -c "import json; r=json.load(open('$REGISTRY')); print(r['projects']['$PROJECT']['screen_name'])")

if screen -ls | grep -q "$SCREEN_NAME"; then
  echo "Session '$SCREEN_NAME' is already running."
  exit 0
fi

screen -dmS "$SCREEN_NAME" zsh -ic "cd $PATH_DIR && DISCORD_STATE_DIR=$STATE_DIR claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions"
echo "Started Discord bot in screen session '$SCREEN_NAME'"
echo "Attach with: screen -r $SCREEN_NAME"
