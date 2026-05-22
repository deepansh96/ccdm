#!/bin/zsh
# Usage: ./scripts/start-codex-session.sh <project_name>
# Reads registry.json to get project config and starts a Codex Discord bridge session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="$1"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project_name>"
  exit 1
fi

IFS=$'\t' read -r PATH_DIR STATE_DIR SCREEN_NAME BOT_TOKEN CHANNEL_ID WS_PORT DISCORD_USER_ID GUILD_ID ROOT_TOKEN BOT_APP_ID BOT_ID <<< "$(python3 -c "
import json, os
r = json.load(open('$REGISTRY'))
p = r['projects']['$PROJECT']
bot = next(b for b in r['pool'] if b['id'] == p['bot_id'])
root_bot = next(b for b in r['pool'] if b['id'] == 'bot1')
print('\t'.join([
    os.path.expanduser(p['path']),
    os.path.expanduser(bot['state_dir']),
    p['screen_name'],
    bot['token'],
    p['channel_id'],
    str(p.get('ws_port', 18300)),
    r['discord_user_id'],
    r['guild_id'],
    root_bot['token'],
    bot['app_id'],
    bot['id']
]))
")"

if tmux has-session -t "=$SCREEN_NAME" 2>/dev/null; then
  echo "Session '$SCREEN_NAME' is already running."
  exit 0
fi

# Remove stale discord MCP entries from global codex config (they get re-registered per session)
python3 -c "
import os
config_path = os.path.expanduser('~/.codex/config.toml')
if os.path.exists(config_path):
    with open(config_path) as f:
        lines = f.readlines()
    filtered, skip = [], False
    for line in lines:
        if line.startswith('[mcp_servers.discord-'):
            skip = True
            continue
        if skip and line.startswith('['):
            skip = False
        if skip:
            continue
        filtered.append(line)
    # Remove consecutive blank lines
    result, prev_blank = [], False
    for line in filtered:
        blank = line.strip() == ''
        if blank and prev_blank:
            continue
        result.append(line)
        prev_blank = blank
    with open(config_path, 'w') as f:
        f.writelines(result)
" 2>/dev/null || true

BOT_DISPLAY_NAME="${BOT_ID}-${PROJECT}-codex"

tmux new-session -d -s "$SCREEN_NAME" -- zsh -ic "cd '$ROOT_DIR' && BOT_TOKEN='$BOT_TOKEN' CHANNEL_ID='$CHANNEL_ID' PROJECT_DIR='$PATH_DIR' WS_PORT='$WS_PORT' ALLOWED_USER_ID='$DISCORD_USER_ID' GUILD_ID='$GUILD_ID' ROOT_BOT_TOKEN='$ROOT_TOKEN' BOT_APP_ID='$BOT_APP_ID' BOT_DISPLAY_NAME='$BOT_DISPLAY_NAME' node scripts/codex-bridge.js"
echo "Started Codex bridge in tmux session '$SCREEN_NAME'"
echo "Attach with: tmux attach -t $SCREEN_NAME"
