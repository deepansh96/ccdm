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
  python3 "$SCRIPT_DIR/claude-launch.py" listener-pids "$1"
}

clear_claude_capability_marker() {
  python3 - "$PROJECT" <<'PY'
import os
import sys
from pathlib import Path

project = sys.argv[1]
state_dir = Path(os.environ.get("CCDM_REMINDER_STATE_DIR") or Path.home() / ".local" / "state" / "ccdm" / "conversation-reminders")
if "/" not in project and project not in {"", ".", ".."}:
    (state_dir / "capabilities" / f"{project}.json").unlink(missing_ok=True)
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
    return exe == "claude" and (
        ("--channels" in argv and any(arg.startswith("plugin:discord") for arg in argv))
        or ("--dangerously-load-development-channels" in argv and "server:discord" in argv)
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

# Read project config and resolve the bot's state_dir through the shared
# Claude launch helper, which also validates claude_effort.
PROJECT_CONFIG_FIELDS="$(python3 "$SCRIPT_DIR/claude-launch.py" resolve "$REGISTRY" "$PROJECT")" || exit $?
IFS=$'\t' read -r PATH_DIR STATE_DIR SCREEN_NAME MODEL CLAUDE_EFFORT CLAUDE_HOME CHANNEL_ID <<< "$PROJECT_CONFIG_FIELDS"

[[ "$CLAUDE_HOME" == "__NONE__" ]] && CLAUDE_HOME=""

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

# Only the adapter of this launch may prove Conversation Reminder support; a
# plain launch is scoped by the same proxy but stays unsupported.
clear_claude_capability_marker
# Every Channel Conversation runs behind the conversation-scoped proxy so that
# thread traffic never reaches it. The shared helper writes the proxy's MCP
# config and settings (reminder launches, CCDM_CLAUDE_REMINDER_ADAPTER=1, add
# command hooks) and maps model, effort, and account into the launch command.
LAUNCH_COMMAND="$(python3 "$SCRIPT_DIR/claude-launch.py" launch-command "$REGISTRY" "$PROJECT")" || exit $?
tmux new-session -d -s "$SCREEN_NAME" -- zsh -ic "$LAUNCH_COMMAND"
echo "Started Discord bot in tmux session '$SCREEN_NAME'"
echo "Attach with: tmux attach -t $SCREEN_NAME"
record_claude_pid "$STATE_DIR" "$CLAUDE_HOME"
