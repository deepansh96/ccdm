#!/bin/zsh
# Usage: ./scripts/stop-session.sh <project_name> [--threads|--all]
# Reads registry.json to get the tmux session name and stops it: the channel
# session only, leaving thread sessions running. --threads stops only the
# project's thread sessions, as operator stops through the Thread Supervisor
# (or by their .thread-<id>.key paths when it is down); --all stops both.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="${1:-}"
MODE="${2:-}"

if [[ -z "$PROJECT" || $# -gt 2 || ( -n "$MODE" && "$MODE" != "--threads" && "$MODE" != "--all" ) ]]; then
  echo "Usage: $0 <project_name> [--threads|--all]"
  exit 1
fi

stop_threads() {
  python3 - "$ROOT_DIR" "$PROJECT" <<'PY'
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(sys.argv[1]) / "scripts"))
from thread_supervisor.operator_stop import main
raise SystemExit(main(Path(sys.argv[1]), sys.argv[2]))
PY
}

if [[ "$MODE" == "--threads" ]]; then
  stop_threads
  exit $?
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

# A Claude listener left from before the Router cutover: the official Discord
# plugin (or the retired reminder proxy) started with its pool bot's
# DISCORD_STATE_DIR. The pool fields locate it until retire-pool.sh strips them.
find_legacy_pool_claude_pids() {
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

    if exe == "claude" and (
        ("--channels" in argv and any(arg.startswith("plugin:discord") for arg in argv))
        or ("--dangerously-load-development-channels" in argv and "server:discord" in argv)
    ):
        return True
    if exe == "node" and any(os.path.basename(arg) == "claude-reminder-channel.js" for arg in argv[1:]):
        return True
    if exe == "claude-channel-discord":
        return True
    if exe == "bun" and "run" in argv and has_claude_discord_cwd(argv):
        return True
    if exe == "bun" and any(
        os.path.basename(arg) == "server.ts" and
        (is_discord_plugin_path(arg) or has_claude_discord_plugin_root(command))
        for arg in argv[1:]
    ):
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
# A Claude project that still names its former pool bot also has that bot's
# state directory swept for a legacy listener.
IFS=$'\t' read -r SCREEN_NAME SESSION_TYPE REGISTRY_PID CHANNEL_ID WS_PORT LEGACY_STATE_DIR <<< "$(python3 -c "
import json, os
r = json.load(open('$REGISTRY'))
p = r['projects']['$PROJECT']
session_type = p.get('type', 'claude')
def field(value):
    return '__NONE__' if value in (None, '') else str(value)
ws_port = p.get('ws_port', 18300) if session_type == 'codex' else p.get('ws_port')
pool = r.get('pool') if isinstance(r.get('pool'), list) else []
bot = next((b for b in pool if isinstance(b, dict) and p.get('bot_id') and b.get('id') == p.get('bot_id')), {})
legacy_state_dir = os.path.expanduser(bot['state_dir']) if session_type != 'codex' and bot.get('state_dir') else None
print('\t'.join([
    field(p['screen_name']),
    field(session_type),
    field(p.get('pid')),
    field(p.get('channel_id')),
    field(ws_port),
    field(legacy_state_dir),
]))
")"

[[ "$REGISTRY_PID" == "__NONE__" ]] && REGISTRY_PID=""
[[ "$CHANNEL_ID" == "__NONE__" ]] && CHANNEL_ID=""
[[ "$WS_PORT" == "__NONE__" ]] && WS_PORT=""
[[ "$LEGACY_STATE_DIR" == "__NONE__" ]] && LEGACY_STATE_DIR=""

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
    if [[ -n "$LEGACY_STATE_DIR" ]]; then
      find_legacy_pool_claude_pids "$LEGACY_STATE_DIR"
    fi
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

python3 "$SCRIPT_DIR/registry-update.py" set-project-fields "$REGISTRY" "$PROJECT" '{"session_id": null, "pid": null}'

echo "Stopped Discord session '$PROJECT'"

if [[ "$MODE" == "--all" ]]; then
  stop_threads
fi
