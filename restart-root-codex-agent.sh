#!/bin/zsh
# Restart the root Discord bot as a Codex bridge for one channel.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="$SCRIPT_DIR/registry.json"
ROOT_STATE_DIR="${ROOT_DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}"
ENV_FILE="$ROOT_STATE_DIR/.env"
ACCESS_FILE="$ROOT_STATE_DIR/access.json"

CHANNEL_ID="${1:-${ROOT_CODEX_CHANNEL_ID:-}}"
WS_PORT="${ROOT_CODEX_WS_PORT:-18399}"
CODEX_HOME_DIR="${ROOT_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
BOT_DISPLAY_NAME="${ROOT_CODEX_BOT_DISPLAY_NAME:-root-codex}"

if [[ -z "$CHANNEL_ID" && -f "$ACCESS_FILE" ]]; then
  CHANNEL_ID="$(python3 - "$ACCESS_FILE" <<'PY'
import json
import sys

groups = json.load(open(sys.argv[1])).get("groups", {})
root_channels = [
    channel_id
    for channel_id, config in groups.items()
    if config.get("requireMention") is False
]
if len(root_channels) == 1:
    print(root_channels[0])
PY
)"
fi

if [[ -z "$CHANNEL_ID" ]]; then
  echo "Usage: $0 <channel_id> (or set ROOT_CODEX_CHANNEL_ID)" >&2
  echo "Refusing to guess because this root bot can be allowed in multiple channels." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing root bot env file: $ENV_FILE" >&2
  exit 1
fi

BOT_TOKEN="$(python3 - "$ENV_FILE" <<'PY'
import sys

for line in open(sys.argv[1]):
    if line.startswith("DISCORD_BOT_TOKEN="):
        print(line.split("=", 1)[1].strip())
        break
PY
)"

if [[ -z "$BOT_TOKEN" ]]; then
  echo "DISCORD_BOT_TOKEN is missing from $ENV_FILE" >&2
  exit 1
fi

IFS=$'\t' read -r REGISTRY_USER_ID GUILD_ID REGISTRY_ROOT_APP_ID <<< "$(python3 - "$REGISTRY" <<'PY'
import json
import sys

registry = json.load(open(sys.argv[1]))
root_bot = next((bot for bot in registry.get("pool", []) if bot.get("id") == "bot1"), {})
print("\t".join([
    str(registry.get("discord_user_id") or ""),
    str(registry.get("guild_id") or ""),
    str(root_bot.get("app_id") or ""),
]))
PY
)"

ALLOWED_USER_IDS="${ROOT_CODEX_ALLOWED_USER_IDS:-$(python3 - "$REGISTRY_USER_ID" "$ACCESS_FILE" "$CHANNEL_ID" <<'PY'
import json
import os
import sys

ids = [sys.argv[1]]
access_path = sys.argv[2]
channel_id = sys.argv[3]
if os.path.exists(access_path):
    access = json.load(open(access_path))
    ids.extend(access.get("allowFrom") or [])
    ids.extend((access.get("groups", {}).get(channel_id, {}) or {}).get("allowFrom") or [])
seen = set()
deduped = []
for user_id in ids:
    user_id = str(user_id).strip()
    if user_id and user_id not in seen:
        seen.add(user_id)
        deduped.append(user_id)
print(",".join(deduped))
PY
)}"

if [[ -z "$ALLOWED_USER_IDS" ]]; then
  echo "No allowed Discord user IDs found. Set ROOT_CODEX_ALLOWED_USER_IDS." >&2
  exit 1
fi

BOT_APP_ID="${ROOT_CODEX_BOT_APP_ID:-$(python3 - "$BOT_TOKEN" "$REGISTRY_ROOT_APP_ID" <<'PY'
import base64
import sys

token = sys.argv[1]
fallback = sys.argv[2]
try:
    token_id = token.split(".", 1)[0]
    token_id += "=" * ((4 - len(token_id) % 4) % 4)
    print(base64.urlsafe_b64decode(token_id).decode())
except Exception:
    print(fallback)
PY
)}"

if [[ -z "$BOT_APP_ID" ]]; then
  echo "Could not determine root bot app ID. Set ROOT_CODEX_BOT_APP_ID." >&2
  exit 1
fi

# Kill the current root_agent tmux session, whether it is Claude or Codex.
if tmux has-session -t root_agent 2>/dev/null; then
  PANE_PID="$(tmux display-message -t root_agent -p '#{pane_pid}' 2>/dev/null || true)"
  if [[ -n "$PANE_PID" ]]; then
    pkill -TERM -P "$PANE_PID" 2>/dev/null || true
    sleep 1
  fi
  tmux kill-session -t root_agent 2>/dev/null || true
  sleep 2
  if tmux has-session -t root_agent 2>/dev/null; then
    tmux kill-session -t root_agent 2>/dev/null || true
    sleep 1
  fi
fi

if ! tmux new-session -d -s root_agent -- zsh -ic "cd '$SCRIPT_DIR' && CODEX_HOME='$CODEX_HOME_DIR' BOT_TOKEN='$BOT_TOKEN' CHANNEL_ID='$CHANNEL_ID' PROJECT_DIR='$SCRIPT_DIR' WS_PORT='$WS_PORT' ALLOWED_USER_IDS='$ALLOWED_USER_IDS' GUILD_ID='$GUILD_ID' ROOT_BOT_TOKEN='$BOT_TOKEN' ROOT_BOT_APP_ID='$BOT_APP_ID' BOT_APP_ID='$BOT_APP_ID' BOT_DISPLAY_NAME='$BOT_DISPLAY_NAME' ROOT_MULTI_CHANNEL='1' ROOT_ACCESS_FILE='$ACCESS_FILE' node scripts/codex-bridge.js"; then
  echo "Failed to create tmux session 'root_agent'" >&2
  exit 1
fi

echo "Restarted root Codex agent in tmux session 'root_agent'"
echo "Channel: $CHANNEL_ID"
echo "Attach with: tmux attach -t root_agent"
