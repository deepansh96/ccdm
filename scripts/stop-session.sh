#!/bin/zsh
# Usage: ./scripts/stop-session.sh <project_name>
# Reads registry.json to get the tmux session name and stops it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="${1:-}"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project_name>"
  exit 1
fi

collect_tree() {
  local pid="$1"
  [[ "$pid" == <-> ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  echo "$pid"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    collect_tree "$child"
  done
}

terminate_pids() {
  local all=()
  local pid tree
  for pid in "$@"; do
    [[ "$pid" == <-> ]] || continue
    tree="$(collect_tree "$pid")"
    [[ -n "$tree" ]] || continue
    all+=("${(@f)tree}")
  done

  all=("${(@u)all}")
  (( ${#all} == 0 )) && return 0

  kill -TERM $all 2>/dev/null || true
  sleep 2

  for pid in $all; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

find_claude_listener_pids() {
  local state_dir="$1"
  python3 - "$state_dir" <<'PY'
import os
import re
import subprocess
import sys

target = os.path.normpath(os.path.expanduser(sys.argv[1]))
try:
    ps = subprocess.check_output(
        ["ps", "axeww", "-o", "pid=,command="],
        text=True,
        stderr=subprocess.DEVNULL,
    )
except Exception:
    sys.exit(0)

env_re = re.compile(r"""DISCORD_STATE_DIR=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")

def has_target_state(command: str) -> bool:
    for match in env_re.finditer(command):
        value = next(group for group in match.groups() if group is not None)
        if os.path.normpath(os.path.expanduser(value)) == target:
            return True
    return False

def is_listener(command: str) -> bool:
    if "--channels plugin:discord" in command:
        return True
    if "claude-channel-discord" in command:
        return True
    if "bun run --cwd" in command and "/discord" in command:
        return True
    if "server.ts" in command and "/discord" in command and "bun" in command:
        return True
    return False

for line in ps.splitlines():
    line = line.strip()
    if not line:
        continue
    pid_text, _, command = line.partition(" ")
    if not pid_text.isdigit():
        continue
    if "ps axeww" in command or "python3 -" in command:
        continue
    if has_target_state(command) and is_listener(command):
        print(pid_text)
PY
}

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

IFS=$'\t' read -r SCREEN_NAME SESSION_TYPE STATE_DIR REGISTRY_PID CHANNEL_ID WS_PORT BOT_APP_ID <<< "$(python3 -c "
import json, os
r = json.load(open('$REGISTRY'))
p = r['projects']['$PROJECT']
bot = next(b for b in r['pool'] if b['id'] == p['bot_id'])
def field(value):
    return '__NONE__' if value in (None, '') else str(value)
print('\t'.join([
    field(p['screen_name']),
    field(p.get('type', 'claude')),
    field(os.path.expanduser(bot['state_dir'])),
    field(p.get('pid')),
    field(p.get('channel_id')),
    field(p.get('ws_port')),
    field(bot.get('app_id')),
]))
")"

[[ "$REGISTRY_PID" == "__NONE__" ]] && REGISTRY_PID=""
[[ "$CHANNEL_ID" == "__NONE__" ]] && CHANNEL_ID=""
[[ "$WS_PORT" == "__NONE__" ]] && WS_PORT=""
[[ "$BOT_APP_ID" == "__NONE__" ]] && BOT_APP_ID=""

if [[ -n "$REGISTRY_PID" ]]; then
  echo "Stopping recorded process tree for '$PROJECT' (pid $REGISTRY_PID)"
  terminate_pids "$REGISTRY_PID"
fi

tmux kill-session -t "=$SCREEN_NAME" 2>/dev/null && echo "Stopped tmux session '$SCREEN_NAME'" || echo "No active tmux session '$SCREEN_NAME' found"

if [[ "$SESSION_TYPE" == "codex" ]]; then
  ORPHAN_PIDS="$(find_codex_listener_pids "$CHANNEL_ID" "$WS_PORT" "$BOT_APP_ID")"
else
  ORPHAN_PIDS="$(find_claude_listener_pids "$STATE_DIR")"
fi

if [[ -n "$ORPHAN_PIDS" ]]; then
  echo "Cleaning remaining listener process(es):"
  echo "$ORPHAN_PIDS" | sed 's/^/  /'
  terminate_pids "${(@f)ORPHAN_PIDS}"
fi

python3 -c "
import json
path = '$REGISTRY'
project = '$PROJECT'
with open(path) as f:
    registry = json.load(f)
registry['projects'][project]['session_id'] = None
registry['projects'][project]['pid'] = None
with open(path, 'w') as f:
    json.dump(registry, f, indent=2)
    f.write('\n')
"

echo "Stopped Discord session '$PROJECT'"
