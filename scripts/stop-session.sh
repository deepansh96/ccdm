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
import shlex
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

def command_argv(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return []

def is_discord_plugin_path(value: str) -> bool:
    path = os.path.normpath(os.path.expanduser(value))
    plugin_roots = (
        "claude-plugins-official/discord",
        "claude-plugins-official/external_plugins/discord",
    )
    return any(path.endswith(f"/{root}") or f"/{root}/" in path for root in plugin_roots)

def has_claude_discord_plugin_root(command: str) -> bool:
    root_re = re.compile(r"""CLAUDE_PLUGIN_ROOT=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")
    for match in root_re.finditer(command):
        value = next(group for group in match.groups() if group is not None)
        if is_discord_plugin_path(value):
            return True
    return False

def has_claude_discord_cwd(argv: list[str]) -> bool:
    for index, arg in enumerate(argv[:-1]):
        if arg == "--cwd" and is_discord_plugin_path(argv[index + 1]):
            return True
    return False

def is_listener(command: str) -> bool:
    argv = command_argv(command)
    if not argv:
        return False

    exe = os.path.basename(argv[0])
    if exe in {"tmux", "zsh", "bash", "sh", "fish", "login"}:
        return False

    if exe == "claude" and "--channels" in argv and any(
        arg.startswith("plugin:discord") for arg in argv
    ):
        return True
    if exe == "claude-channel-discord":
        return True
    if exe == "bun" and "run" in argv and has_claude_discord_cwd(argv):
        return True
    if exe == "bun" and any(os.path.basename(arg) == "server.ts" for arg in argv[1:]) and has_claude_discord_plugin_root(command):
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
import os
import re
import shlex
import subprocess
import sys

channel_id, ws_port, bot_app_id = sys.argv[1:4]
if not channel_id or not ws_port or not bot_app_id:
    sys.exit(0)

try:
    ps = subprocess.check_output(
        ["ps", "axeww", "-o", "pid=,command="],
        text=True,
        stderr=subprocess.DEVNULL,
    )
except Exception:
    sys.exit(0)

def command_argv(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return []

def has_env(command: str, name: str, value: str) -> bool:
    env_re = re.compile(rf"""(?:^|\s){re.escape(name)}=(?:"([^"]*)"|'([^']*)'|([^\s]+))""")
    for match in env_re.finditer(command):
        found = next(group for group in match.groups() if group is not None)
        if found == value:
            return True
    return False

def is_codex_bridge(command: str) -> bool:
    argv = command_argv(command)
    if len(argv) < 2:
        return False
    exe = os.path.basename(argv[0])
    script = os.path.normpath(argv[1])
    return (
        exe == "node"
        and script.endswith("scripts/codex-bridge.js")
        and (has_env(command, "CHANNEL_ID", channel_id) or has_env(command, "BOT_APP_ID", bot_app_id))
    )

def is_codex_app_server(command: str) -> bool:
    argv = command_argv(command)
    if not argv:
        return False
    exe = os.path.basename(argv[0])
    if exe not in {"node", "codex"}:
        return False
    return "app-server" in argv and f"ws://127.0.0.1:{ws_port}" in argv

for line in ps.splitlines():
    line = line.strip()
    if not line:
        continue
    pid_text, _, command = line.partition(" ")
    if not pid_text.isdigit():
        continue
    if "ps axeww" in command or "python3 -" in command:
        continue
    if is_codex_bridge(command) or is_codex_app_server(command):
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
session_type = p.get('type', 'claude')
ws_port = p.get('ws_port', 18300) if session_type == 'codex' else p.get('ws_port')
print('\t'.join([
    field(p['screen_name']),
    field(session_type),
    field(os.path.expanduser(bot['state_dir'])),
    field(p.get('pid')),
    field(p.get('channel_id')),
    field(ws_port),
    field(bot.get('app_id')),
]))
")"

[[ "$REGISTRY_PID" == "__NONE__" ]] && REGISTRY_PID=""
[[ "$CHANNEL_ID" == "__NONE__" ]] && CHANNEL_ID=""
[[ "$WS_PORT" == "__NONE__" ]] && WS_PORT=""
[[ "$BOT_APP_ID" == "__NONE__" ]] && BOT_APP_ID=""

find_owned_listener_pids() {
  if [[ "$SESSION_TYPE" == "codex" ]]; then
    if [[ -z "$CHANNEL_ID" || -z "$WS_PORT" || -z "$BOT_APP_ID" ]]; then
      echo "Skipping Codex listener sweep for '$PROJECT': missing channel_id, ws_port, or bot_app_id" >&2
      return 0
    fi
    find_codex_listener_pids "$CHANNEL_ID" "$WS_PORT" "$BOT_APP_ID"
  else
    find_claude_listener_pids "$STATE_DIR"
  fi
}

if [[ -n "$REGISTRY_PID" ]]; then
  OWNED_PIDS="$(find_owned_listener_pids)"
  if printf '%s\n' "${(@f)OWNED_PIDS}" | grep -Fxq "$REGISTRY_PID"; then
    echo "Stopping recorded process tree for '$PROJECT' (pid $REGISTRY_PID)"
    terminate_pids "$REGISTRY_PID"
  else
    echo "Skipping recorded pid $REGISTRY_PID: it no longer belongs to '$PROJECT'"
  fi
fi

tmux kill-session -t "=$SCREEN_NAME" 2>/dev/null && echo "Stopped tmux session '$SCREEN_NAME'" || echo "No active tmux session '$SCREEN_NAME' found"

ORPHAN_PIDS="$(find_owned_listener_pids)"

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
