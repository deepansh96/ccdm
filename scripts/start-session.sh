#!/bin/zsh
# Usage: ./scripts/start-session.sh <project_name>
# Reads registry.json (pool + projects) to get project config and starts a Claude Code Discord session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="${1:-}"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project_name>"
  exit 1
fi

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

record_claude_pid() {
  local state_dir="$1"
  local claude_home="$2"
  python3 - "$REGISTRY" "$PROJECT" "$state_dir" "$claude_home" <<'PY'
import json
import os
import re
import shlex
import subprocess
import sys
import time

registry_path, project, state_arg = sys.argv[1:4]
claude_home = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else "~/.claude"
target = os.path.normpath(os.path.expanduser(state_arg))
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

def is_claude_discord_process(command: str) -> bool:
    argv = command_argv(command)
    if not argv:
        return False
    exe = os.path.basename(argv[0])
    if exe in {"tmux", "zsh", "bash", "sh", "fish", "login"}:
        return False
    return exe == "claude" and "--channels" in argv and any(
        arg.startswith("plugin:discord") for arg in argv
    )

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
        if is_claude_discord_process(command) and has_target_state(command):
            return int(pid_text)
    return None

pid = None
for _ in range(20):
    pid = find_pid()
    if pid:
        break
    time.sleep(0.5)

if not pid:
    print("Warning: started session, but could not find Claude listener PID to record")
    sys.exit(0)

session_id = None
session_file = os.path.join(os.path.expanduser(claude_home), "sessions", f"{pid}.json")
for _ in range(20):
    try:
        with open(session_file) as f:
            session = json.load(f)
        session_id = session.get("sessionId") or session.get("session_id") or session.get("id")
        break
    except Exception:
        time.sleep(0.5)

with open(registry_path) as f:
    registry = json.load(f)
registry["projects"][project]["pid"] = pid
registry["projects"][project]["session_id"] = session_id
with open(registry_path, "w") as f:
    json.dump(registry, f, indent=2)
    f.write("\n")

if session_id:
    print(f"Recorded PID {pid} and session {session_id}")
else:
    print(f"Recorded PID {pid}; session_id not found yet")
PY
}

# Read project config and resolve bot's state_dir from the pool
# Uses tab delimiter to handle paths with spaces; empty optional fields are
# printed as __NONE__ because adjacent tabs collapse under zsh IFS splitting.
IFS=$'\t' read -r PATH_DIR STATE_DIR SCREEN_NAME MODEL CLAUDE_HOME <<< "$(python3 -c "
import json, os
r = json.load(open('$REGISTRY'))
p = r['projects']['$PROJECT']
bot = next(b for b in r['pool'] if b['id'] == p['bot_id'])
claude_home = os.path.expanduser(p['claude_home']) if p.get('claude_home') else '__NONE__'
print(os.path.expanduser(p['path']) + '\t' + os.path.expanduser(bot['state_dir']) + '\t' + p['screen_name'] + '\t' + (p.get('model') or '__NONE__') + '\t' + claude_home)
")"

[[ "$MODEL" == "__NONE__" ]] && MODEL=""
[[ "$CLAUDE_HOME" == "__NONE__" ]] && CLAUDE_HOME=""

# Optional model override (e.g. "claude-opus-4-8[1m]"). Empty -> account default.
MODEL_FLAG=""
if [[ -n "$MODEL" ]]; then
  MODEL_FLAG=" --model '$MODEL'"
fi

# Optional account override (e.g. "~/.claude-af"). Empty -> default ~/.claude login.
CONFIG_DIR_ENV=""
if [[ -n "$CLAUDE_HOME" ]]; then
  CONFIG_DIR_ENV=" CLAUDE_CONFIG_DIR='$CLAUDE_HOME'"
fi

if tmux has-session -t "=$SCREEN_NAME" 2>/dev/null; then
  echo "Session '$SCREEN_NAME' is already running."
  exit 0
fi

EXISTING_PIDS="$(find_claude_listener_pids "$STATE_DIR")"
if [[ -n "$EXISTING_PIDS" ]]; then
  echo "Refusing to start '$PROJECT': existing Claude Discord listener process(es) already use $STATE_DIR:"
  echo "$EXISTING_PIDS" | sed 's/^/  /'
  echo "Run scripts/stop-session.sh '$PROJECT' first, then retry."
  exit 1
fi

tmux new-session -d -s "$SCREEN_NAME" -- zsh -ic "cd '$PATH_DIR' && DISCORD_STATE_DIR='$STATE_DIR'$CONFIG_DIR_ENV claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions$MODEL_FLAG"
echo "Started Discord bot in tmux session '$SCREEN_NAME'"
echo "Attach with: tmux attach -t $SCREEN_NAME"
record_claude_pid "$STATE_DIR" "$CLAUDE_HOME"
