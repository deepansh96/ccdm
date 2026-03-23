#!/bin/zsh
# Usage: ./scripts/start-session.sh <project_name>
# Reads registry.json (pool + projects) to get project config and starts a Claude Code Discord session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="$1"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project_name>"
  exit 1
fi

# Read project config and resolve bot's state_dir from the pool
# Uses tab delimiter to handle paths with spaces
IFS=$'\t' read -r PATH_DIR STATE_DIR SCREEN_NAME <<< "$(python3 -c "
import json, os
r = json.load(open('$REGISTRY'))
p = r['projects']['$PROJECT']
bot = next(b for b in r['pool'] if b['id'] == p['bot_id'])
print(os.path.expanduser(p['path']) + '\t' + os.path.expanduser(bot['state_dir']) + '\t' + p['screen_name'])
")"

if screen -ls | grep -q "$SCREEN_NAME"; then
  echo "Session '$SCREEN_NAME' is already running."
  exit 0
fi

screen -dmS "$SCREEN_NAME" zsh -ic "cd '$PATH_DIR' && DISCORD_STATE_DIR='$STATE_DIR' claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions"
echo "Started Discord bot in screen session '$SCREEN_NAME'"
echo "Attach with: screen -r $SCREEN_NAME"
