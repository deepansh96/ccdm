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

record_claude_pid() {
  local state_dir="$1"
  python3 - "$REGISTRY" "$PROJECT" "$state_dir" <<'PY'
import json
import os
import re
import subprocess
import sys
import time

registry_path, project, state_arg = sys.argv[1:4]
target = os.path.normpath(os.path.expanduser(state_arg))
env_re = re.compile(r"""DISCORD_STATE_DIR=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")

def has_target_state(command: str) -> bool:
    for match in env_re.finditer(command):
        value = next(group for group in match.groups() if group is not None)
        if os.path.normpath(os.path.expanduser(value)) == target:
            return True
    return False

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
        if command.startswith("claude ") and "--channels plugin:discord" in command and has_target_state(command):
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
session_file = os.path.expanduser(f"~/.claude/sessions/{pid}.json")
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
# Uses tab delimiter to handle paths with spaces
IFS=$'\t' read -r PATH_DIR STATE_DIR SCREEN_NAME <<< "$(python3 -c "
import json, os
r = json.load(open('$REGISTRY'))
p = r['projects']['$PROJECT']
bot = next(b for b in r['pool'] if b['id'] == p['bot_id'])
print(os.path.expanduser(p['path']) + '\t' + os.path.expanduser(bot['state_dir']) + '\t' + p['screen_name'])
")"

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

tmux new-session -d -s "$SCREEN_NAME" -- zsh -ic "cd '$PATH_DIR' && DISCORD_STATE_DIR='$STATE_DIR' claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions"
echo "Started Discord bot in tmux session '$SCREEN_NAME'"
echo "Attach with: tmux attach -t $SCREEN_NAME"
record_claude_pid "$STATE_DIR"
