#!/bin/zsh
# Usage: ./scripts/start-session.sh <project_name>
# Reads registry.json to get project config and starts a Claude Code session served through the Router.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="${1:-}"

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project_name>"
  exit 1
fi

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

# The listener is found by its launch key file path in CCDM_ROUTER_KEY_FILE.
record_claude_pid() {
  local key_file="$1"
  local claude_home="$2"
  python3 - "$REGISTRY" "$PROJECT" "$key_file" "$claude_home" <<'PY'
import json
import os
import re
import shlex
import subprocess
import sys
import time

registry_path, project, key_arg = sys.argv[1:4]
claude_home = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else "~/.claude"
target = os.path.normpath(os.path.expanduser(key_arg))
env_re = re.compile(r"""CCDM_ROUTER_KEY_FILE=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")

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
    return exe == "claude" and "--dangerously-load-development-channels" in argv and "server:ccdm" in argv

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

# Claude listeners carry this launch's key file path (never the key)
# in their environment: the claude process and its CCDM channel server.
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

# Every Claude session is a Router client and holds no Discord token. A fresh launch key
# (which revokes the previous launch) lets the CCDM channel server say hello
# to the Router; the PID is recorded only after that hello succeeds.
start_router_session() {
  local router_state="${CCDM_ROUTER_STATE_DIR:-$HOME/.local/state/ccdm/router}"
  local key_file="$router_state/keys/$PROJECT.key"
  local launch_dir="$router_state/launches/$PROJECT"
  local mcp_config="$launch_dir/mcp.json"
  local settings="$launch_dir/settings.json"
  local ready_file="$launch_dir/ready.json"

  local existing
  existing="$(find_router_claude_pids "$key_file")"
  if [[ -n "$existing" ]]; then
    echo "Refusing to start '$PROJECT': existing Claude Router listener process(es) already use $key_file:"
    echo "$existing" | sed 's/^/  /'
    echo "Run scripts/stop-session.sh '$PROJECT' first, then retry."
    return 1
  fi

  clear_claude_capability_marker
  python3 - "$PROJECT" "$router_state" "$launch_dir" "$SCRIPT_DIR/ccdm-channel-server.js" "$ROOT_DIR" "$CHANNEL_ID" <<'PY' || return 1
import json
import os
import secrets
import sys
from pathlib import Path
from uuid import uuid4

project, router_state, launch_dir, server_script, root_dir, channel_id = sys.argv[1:7]
if not project or "/" in project or project.startswith("."):
    sys.exit(f"Invalid project name for a Router launch: {project!r}")
keys_dir = Path(router_state) / "keys"
launch = Path(launch_dir)
for directory in (Path(router_state), keys_dir, launch.parent, launch):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
(launch / "ready.json").unlink(missing_ok=True)
# A previous launch's context percentage would be wrong for this one.
(launch / "context.json").unlink(missing_ok=True)

def write_private(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)

key_file = keys_dir / f"{project}.key"
# The channel server records Conversation Reminder events itself; Claude and
# its command hooks share this launch's reminder context.
reminder_dir = Path(os.environ.get("CCDM_REMINDER_STATE_DIR") or Path.home() / ".local" / "state" / "ccdm" / "conversation-reminders")
reminder_env = {
    "CCDM_REMINDER_PROJECT_ROOT": root_dir,
    "CCDM_REMINDER_STATE_DIR": str(reminder_dir),
    "CCDM_REMINDER_RECEIPTS_DIR": str(reminder_dir / "claude-receipts"),
    "CCDM_CLAUDE_PROJECT": project,
    "CCDM_CLAUDE_CHANNEL_ID": channel_id,
    "CCDM_CLAUDE_LAUNCH_ID": str(uuid4()),
    "CCDM_CLAUDE_HOOK_SETTINGS": str(launch / "settings.json"),
}
config = {"mcpServers": {"ccdm": {
    "command": "node",
    "args": [server_script],
    "env": {
        **reminder_env,
        "CCDM_ROUTER_STATE_DIR": router_state,
        "CCDM_ROUTER_KEY_FILE": str(key_file),
        "CCDM_CHANNEL_READY_FILE": str(launch / "ready.json"),
    },
}}}
write_private(launch / "mcp.json", json.dumps(config, indent=2) + "\n")
# The official Discord plugin must not load beside the CCDM channel. Hook
# commands are command hooks: no prompt/agent hook can invoke a model.
hook = str(Path(root_dir) / "scripts" / "claude-reminder-hook.js")
write_private(launch / "settings.json", json.dumps({
    "enabledPlugins": {"discord@claude-plugins-official": False},
    "hooks": {event: [{"hooks": [{"type": "command", "command": f"node '{hook}'"}]}]
              for event in ("SessionStart", "Stop", "StopFailure", "SessionEnd")},
}, indent=2) + "\n")
write_private(launch / "reminder-env.json", json.dumps(reminder_env) + "\n")
# Replacing the key revokes whichever session still holds the old one.
write_private(key_file, secrets.token_urlsafe(32) + "\n")
PY

  local reminder_env
  reminder_env="$(python3 - "$launch_dir/reminder-env.json" <<'PY'
import json,sys
e=json.load(open(sys.argv[1]))
print(''.join(f" {k}='{v}'" for k,v in e.items()))
PY
)"
  tmux new-session -d -s "$SCREEN_NAME" -- zsh -ic "cd '$PATH_DIR' && CCDM_ROUTER_KEY_FILE='$key_file'$reminder_env$CONFIG_DIR_ENV claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions --mcp-config '$mcp_config' --settings '$settings'$MODEL_FLAG$EFFORT_FLAG"
  echo "Started Claude Router session in tmux session '$SCREEN_NAME'"

  # Accept the per-launch development-channel confirmation, then wait for the
  # channel server's Router hello.
  if ! python3 - "$SCREEN_NAME" "$ready_file" <<'PY'
import json
import os
import re
import subprocess
import sys
import time

screen, ready_file = sys.argv[1:3]
timeout = float(os.environ.get("CCDM_CLAUDE_LAUNCH_TIMEOUT_S") or 60)
deadline = time.monotonic() + timeout
prompt = re.compile(r"development channels?", re.IGNORECASE)

accepted = False
while time.monotonic() < deadline:
    pane = subprocess.run(["tmux", "capture-pane", "-t", f"={screen}", "-p"], capture_output=True, text=True)
    if pane.returncode != 0:
        sys.exit("Claude exited before the development-channel confirmation")
    if prompt.search(pane.stdout):
        subprocess.run(["tmux", "send-keys", "-t", f"={screen}", "Enter"], check=True)
        accepted = True
        break
    time.sleep(0.2)
if not accepted:
    sys.exit("The development-channel confirmation never appeared")

while time.monotonic() < deadline:
    try:
        with open(ready_file) as f:
            outcome = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        time.sleep(0.2)
        continue
    if outcome.get("ok"):
        print(f"Channel server connected to the Router (scope {outcome['scope']['channel_id']})")
        sys.exit(0)
    sys.exit(f"The channel server's Router hello failed: {outcome.get('error')}")
sys.exit("The channel server never said hello to the Router")
PY
  then
    echo "Launch of '$PROJECT' failed; cleaning up" >&2
    tmux kill-session -t "=$SCREEN_NAME" 2>/dev/null || true
    local leftover
    leftover="$(find_router_claude_pids "$key_file")"
    # A listener may exit on its own between the sweep and the kill.
    if [[ -n "$leftover" ]]; then
      kill -TERM ${(f)leftover} 2>/dev/null || true
    fi
    python3 - "$key_file" "$launch_dir" <<'PY'
import shutil
import sys
from pathlib import Path

key_file, launch_dir = sys.argv[1:3]
Path(key_file).unlink(missing_ok=True)
shutil.rmtree(launch_dir, ignore_errors=True)
PY
    clear_claude_capability_marker
    return 1
  fi

  echo "Attach with: tmux attach -t $SCREEN_NAME"
  record_claude_pid "$key_file" "$CLAUDE_HOME"
}

# Read project config. Claude has no pool mode, so `transport` is ignored.
# Uses tab delimiter to handle paths with spaces; empty optional fields are
# printed as __NONE__ because adjacent tabs collapse under zsh IFS splitting.
PROJECT_CONFIG_FIELDS="$(python3 - "$REGISTRY" "$PROJECT" <<'PY'
import json, os, sys
r = json.load(open(sys.argv[1]))
p = r['projects'][sys.argv[2]]
effort = p.get('claude_effort')
if effort is None or effort == '':
    effort = '__NONE__'
elif not isinstance(effort, str) or effort not in ('low', 'medium', 'high', 'xhigh', 'max'):
    sys.exit('Invalid claude_effort (expected low, medium, high, xhigh, or max)')
claude_home = os.path.expanduser(p['claude_home']) if p.get('claude_home') else '__NONE__'
print(os.path.expanduser(p['path']) + '\t' + p['screen_name'] + '\t' + (p.get('model') or '__NONE__') + '\t' + effort + '\t' + claude_home + '\t' + str(p['channel_id']))
PY
)" || exit $?
IFS=$'\t' read -r PATH_DIR SCREEN_NAME MODEL CLAUDE_EFFORT CLAUDE_HOME CHANNEL_ID <<< "$PROJECT_CONFIG_FIELDS"

[[ "$MODEL" == "__NONE__" ]] && MODEL=""
[[ "$CLAUDE_EFFORT" == "__NONE__" ]] && CLAUDE_EFFORT=""
[[ "$CLAUDE_HOME" == "__NONE__" ]] && CLAUDE_HOME=""

# Optional model override (e.g. "claude-opus-4-8[1m]"). Empty -> account default.
MODEL_FLAG=""
if [[ -n "$MODEL" ]]; then
  MODEL_FLAG=" --model '$MODEL'"
fi

# Optional Claude effort override. Empty -> account/model default.
EFFORT_FLAG=""
if [[ -n "$CLAUDE_EFFORT" ]]; then
  case "$CLAUDE_EFFORT" in
    low|medium|high|xhigh|max) ;;
    *)
      echo "Invalid claude_effort '$CLAUDE_EFFORT' for '$PROJECT' (expected low, medium, high, xhigh, or max)" >&2
      exit 1
      ;;
  esac
  EFFORT_FLAG=" --effort '$CLAUDE_EFFORT'"
fi

# Optional account override (e.g. "~/.claude-work"). Empty -> default ~/.claude login.
CONFIG_DIR_ENV=""
if [[ -n "$CLAUDE_HOME" ]]; then
  CONFIG_DIR_ENV=" CLAUDE_CONFIG_DIR='$CLAUDE_HOME'"
fi

if tmux has-session -t "=$SCREEN_NAME" 2>/dev/null; then
  echo "Session '$SCREEN_NAME' is already running."
  exit 0
fi

start_router_session
