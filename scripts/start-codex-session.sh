#!/bin/zsh
# Usage: ./scripts/start-codex-session.sh <project_name>
# Reads registry.json to get project config and starts a Codex Discord bridge session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="${1:-}"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project_name>"
  exit 1
fi

find_codex_listener_pids() {
  local channel_id="$1"
  local ws_port="$2"
  local bot_app_id="$3"
  python3 - "$channel_id" "$ws_port" "$bot_app_id" <<'PY'
import subprocess
import sys

channel_id, ws_port, bot_app_id = sys.argv[1:4]
try:
    ps = subprocess.check_output(
        ["ps", "axeww", "-o", "pid=,command="],
        text=True,
        stderr=subprocess.DEVNULL,
    )
except Exception:
    sys.exit(0)

for line in ps.splitlines():
    line = line.strip()
    if not line:
        continue
    pid_text, _, command = line.partition(" ")
    if not pid_text.isdigit():
        continue
    if "ps axeww" in command or "python3 -" in command:
        continue
    is_bridge = "node scripts/codex-bridge.js" in command and (
        f"CHANNEL_ID={channel_id}" in command or f"BOT_APP_ID={bot_app_id}" in command
    )
    is_app_server = f"app-server --listen ws://127.0.0.1:{ws_port}" in command
    if is_bridge or is_app_server:
        print(pid_text)
PY
}

record_codex_pid() {
  local channel_id="$1"
  local bot_app_id="$2"
  python3 - "$REGISTRY" "$PROJECT" "$channel_id" "$bot_app_id" <<'PY'
import json
import subprocess
import sys
import time

registry_path, project, channel_id, bot_app_id = sys.argv[1:5]

def find_pid() -> int | None:
    try:
        ps = subprocess.check_output(
            ["ps", "axeww", "-o", "pid=,command="],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    for line in ps.splitlines():
        line = line.strip()
        if not line:
            continue
        pid_text, _, command = line.partition(" ")
        if not pid_text.isdigit():
            continue
        if "ps axeww" in command or "python3 -" in command:
            continue
        if "node scripts/codex-bridge.js" in command and (
            f"CHANNEL_ID={channel_id}" in command or f"BOT_APP_ID={bot_app_id}" in command
        ):
            return int(pid_text)
    return None

pid = None
for _ in range(20):
    pid = find_pid()
    if pid:
        break
    time.sleep(0.5)

if not pid:
    print("Warning: started session, but could not find Codex bridge PID to record")
    sys.exit(0)

with open(registry_path) as f:
    registry = json.load(f)
registry["projects"][project]["pid"] = pid
registry["projects"][project]["session_id"] = None
with open(registry_path, "w") as f:
    json.dump(registry, f, indent=2)
    f.write("\n")

print(f"Recorded PID {pid}")
PY
}

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

EXISTING_PIDS="$(find_codex_listener_pids "$CHANNEL_ID" "$WS_PORT" "$BOT_APP_ID")"
if [[ -n "$EXISTING_PIDS" ]]; then
  echo "Refusing to start '$PROJECT': existing Codex Discord bridge process(es) already use channel $CHANNEL_ID or port $WS_PORT:"
  echo "$EXISTING_PIDS" | sed 's/^/  /'
  echo "Run scripts/stop-session.sh '$PROJECT' first, then retry."
  exit 1
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
record_codex_pid "$CHANNEL_ID" "$BOT_APP_ID"
