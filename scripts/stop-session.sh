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

# Claude listeners carry their launch key file path (never the key) in their
# environment: the claude process and its channel server.
find_router_claude_pids() {
  local key_file="$1"
  python3 - "$key_file" <<'PY'
import os
import re
import shlex
import subprocess
import sys

target = os.path.normpath(sys.argv[1])
try:
    ps = subprocess.check_output(["ps", "axeww", "-o", "pid=,command="], text=True, stderr=subprocess.DEVNULL)
except Exception:
    sys.exit(0)
env_re = re.compile(r"""CCDM_ROUTER_KEY_FILE=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")

def is_listener(command: str) -> bool:
    try:
        argv = shlex.split(command)
    except ValueError:
        return False
    if not argv:
        return False
    exe = os.path.basename(argv[0])
    if exe == "claude":
        return "--dangerously-load-development-channels" in argv and "server:ccdm" in argv
    return exe == "node" and any(os.path.basename(arg) == "ccdm-channel-server.js" for arg in argv[1:])

for line in ps.splitlines():
    pid_text, _, command = line.strip().partition(" ")
    if not pid_text.isdigit() or "ps axeww" in command or "python3 -" in command:
        continue
    keys = [next(g for g in m.groups() if g is not None) for m in env_re.finditer(command)]
    if any(os.path.normpath(key) == target for key in keys) and is_listener(command):
        print(pid_text)
PY
}

find_codex_listener_pids() {
  local channel_id="$1"
  local ws_port="$2"
  python3 - "$channel_id" "$ws_port" <<'PY'
import os
import re
import shlex
import subprocess
import sys

channel_id, ws_port = sys.argv[1:3]
if not channel_id or not ws_port:
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
        and has_env(command, "CHANNEL_ID", channel_id)
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

# Neither Claude nor Codex has a pool mode, so `transport` is ignored.
IFS=$'\t' read -r SCREEN_NAME SESSION_TYPE REGISTRY_PID CHANNEL_ID WS_PORT <<< "$(python3 -c "
import json, os
r = json.load(open('$REGISTRY'))
p = r['projects']['$PROJECT']
session_type = p.get('type', 'claude')
def field(value):
    return '__NONE__' if value in (None, '') else str(value)
ws_port = p.get('ws_port', 18300) if session_type == 'codex' else p.get('ws_port')
print('\t'.join([
    field(p['screen_name']),
    field(session_type),
    field(p.get('pid')),
    field(p.get('channel_id')),
    field(ws_port),
]))
")"

[[ "$REGISTRY_PID" == "__NONE__" ]] && REGISTRY_PID=""
[[ "$CHANNEL_ID" == "__NONE__" ]] && CHANNEL_ID=""
[[ "$WS_PORT" == "__NONE__" ]] && WS_PORT=""

ROUTER_STATE_DIR="${CCDM_ROUTER_STATE_DIR:-$HOME/.local/state/ccdm/router}"
ROUTER_KEY_FILE="$ROUTER_STATE_DIR/keys/$PROJECT.key"

find_owned_listener_pids() {
  if [[ "$SESSION_TYPE" == "codex" ]]; then
    if [[ -z "$CHANNEL_ID" || -z "$WS_PORT" ]]; then
      echo "Skipping Codex listener sweep for '$PROJECT': missing channel_id or ws_port" >&2
      return 0
    fi
    find_codex_listener_pids "$CHANNEL_ID" "$WS_PORT"
  else
    find_router_claude_pids "$ROUTER_KEY_FILE"
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

if [[ "$SESSION_TYPE" != "codex" ]]; then
  # The stopped launch's key and launch files go with it; the next launch writes fresh ones.
  python3 - "$ROUTER_KEY_FILE" "$ROUTER_STATE_DIR/launches/$PROJECT" <<'PY'
import shutil
import sys
from pathlib import Path

key_file, launch_dir = sys.argv[1:3]
if "/" not in Path(key_file).name:
    Path(key_file).unlink(missing_ok=True)
shutil.rmtree(launch_dir, ignore_errors=True)
PY
fi

if [[ "$SESSION_TYPE" != "codex" ]]; then
  # The stopped launch no longer proves a verified Claude transport.
  python3 - "$PROJECT" <<'PY'
import os
import sys
from pathlib import Path

project = sys.argv[1]
state_dir = Path(os.environ.get("CCDM_REMINDER_STATE_DIR") or Path.home() / ".local" / "state" / "ccdm" / "conversation-reminders")
if "/" not in project and project not in {"", ".", ".."}:
    (state_dir / "capabilities" / f"{project}.json").unlink(missing_ok=True)
PY
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
