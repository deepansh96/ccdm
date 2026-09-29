#!/bin/zsh
# Usage: ./scripts/start-codex-session.sh <project_name> [--resume <thread_uuid>]
# Reads registry.json to get project config and starts a Codex Discord bridge session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="${1:-}"
RESUME_THREAD_ID=""
if (( $# > 1 )); then
  if [[ $# != 3 || "$2" != "--resume" ]]; then
    echo "Usage: $0 <project_name> [--resume <thread_uuid>]" >&2
    exit 1
  fi
  RESUME_THREAD_ID="$3"
  if ! python3 - "$RESUME_THREAD_ID" <<'PY'
import sys, uuid
try:
    if str(uuid.UUID(sys.argv[1])) != sys.argv[1]:
        sys.exit(1)
except ValueError:
    sys.exit(1)
PY
  then
    echo "Resume thread must be a canonical UUID" >&2
    exit 1
  fi
fi

if [[ -z "$PROJECT" ]]; then
  echo "Usage: $0 <project_name> [--resume <thread_uuid>]"
  exit 1
fi

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

record_codex_pid() {
  local channel_id="$1"
  python3 - "$REGISTRY" "$PROJECT" "$channel_id" "$RESUME_THREAD_ID" <<'PY'
import json
import os
import re
import shlex
import subprocess
import sys
import time

registry_path, project, channel_id = sys.argv[1:4]

def has_env(command: str, name: str, value: str) -> bool:
    env_re = re.compile(rf"""(?:^|\s){re.escape(name)}=(?:"([^"]*)"|'([^']*)'|([^\s]+))""")
    for match in env_re.finditer(command):
        found = next(group for group in match.groups() if group is not None)
        if found == value:
            return True
    return False

def command_argv(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return []

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
        if is_codex_bridge(command):
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
    sys.exit(1 if sys.argv[4] else 0)

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

# Every Codex project is served through the Router, whatever its registry
# `transport` field says: the bridge holds no Discord token. A fresh launch key
# (which revokes the previous launch) lets the bridge say hello to the Router;
# the PID is recorded only after that hello succeeds.
start_router_session() {
  local router_state="${CCDM_ROUTER_STATE_DIR:-$HOME/.local/state/ccdm/router}"
  local key_file="$router_state/keys/$PROJECT.key"
  local launch_dir="$router_state/launches/$PROJECT"
  local ready_file="$launch_dir/ready.json"

  python3 - "$PROJECT" "$router_state" "$launch_dir" <<'PY' || return 1
import os
import secrets
import sys
from pathlib import Path

project, router_state, launch_dir = sys.argv[1:4]
if not project or "/" in project or project.startswith("."):
    sys.exit(f"Invalid project name for a Router launch: {project!r}")
keys_dir = Path(router_state) / "keys"
launch = Path(launch_dir)
for directory in (Path(router_state), keys_dir, launch.parent, launch):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
# A previous launch's outcome and context percentage are wrong for this one.
(launch / "ready.json").unlink(missing_ok=True)
(launch / "context.json").unlink(missing_ok=True)
key_file = keys_dir / f"{project}.key"
tmp = key_file.with_name(f".{key_file.name}.{os.getpid()}.tmp")
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(secrets.token_urlsafe(32) + "\n")
# Replacing the key revokes whichever session still holds the old one.
os.replace(tmp, key_file)
PY

  tmux new-session -d -s "$SCREEN_NAME" -- zsh -ic "cd '$ROOT_DIR' && CODEX_HOME='$CODEX_HOME_DIR' CCDM_CODEX_PROJECT='$PROJECT' CCDM_ROUTER_STATE_DIR='$router_state' CCDM_ROUTER_KEY_FILE='$key_file' CCDM_CHANNEL_READY_FILE='$ready_file' CHANNEL_ID='$CHANNEL_ID' PROJECT_DIR='$PATH_DIR' WS_PORT='$WS_PORT' ALLOWED_USER_IDS='$DISCORD_USER_IDS'$AUDIO_TRANSCRIPTION_ENV$TEXT_REPLY_FALLBACK_ENV$CODEX_MODEL_ENV$CODEX_REASONING_ENV$CODEX_SERVICE_TIER_ENV node scripts/codex-bridge.js"
  echo "Started Codex Router bridge in tmux session '$SCREEN_NAME'"

  # The bridge reports its hello outcome once Codex is up and bootstrapped.
  if ! python3 - "$SCREEN_NAME" "$ready_file" <<'PY'
import json
import os
import subprocess
import sys
import time

screen, ready_file = sys.argv[1:3]
deadline = time.monotonic() + float(os.environ.get("CCDM_CODEX_LAUNCH_TIMEOUT_S") or 120)
while time.monotonic() < deadline:
    try:
        with open(ready_file) as f:
            outcome = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        if subprocess.run(["tmux", "has-session", "-t", "=" + screen],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            sys.exit("Codex Router launch failed: bridge exited before saying hello")
        time.sleep(0.2)
        continue
    if outcome.get("ok"):
        print(f"Bridge connected to the Router (scope {outcome['scope']['channel_id']})")
        sys.exit(0)
    sys.exit(f"Codex Router launch failed: {outcome.get('error')}")
sys.exit("Codex Router launch failed: the bridge never said hello to the Router")
PY
  then
    echo "Launch of '$PROJECT' failed; cleaning up" >&2
    tmux kill-session -t "=$SCREEN_NAME" 2>/dev/null || true
    local leftover
    leftover="$(find_codex_listener_pids "$CHANNEL_ID" "$WS_PORT")"
    # A listener may exit on its own between the sweep and the kill.
    if [[ -n "$leftover" ]]; then
      kill -TERM ${(f)leftover} 2>/dev/null || true
    fi
    python3 - "$key_file" "$launch_dir" "$REGISTRY" "$PROJECT" <<'PY'
import json
import shutil
import sys
from pathlib import Path

key_file, launch_dir, registry_path, project = sys.argv[1:5]
Path(key_file).unlink(missing_ok=True)
shutil.rmtree(launch_dir, ignore_errors=True)
# No listener survives a failed launch, so none is recorded.
with open(registry_path) as f:
    registry = json.load(f)
registry["projects"][project]["pid"] = None
registry["projects"][project]["session_id"] = None
with open(registry_path, "w") as f:
    json.dump(registry, f, indent=2)
    f.write("\n")
PY
    return 1
  fi

  echo "Attach with: tmux attach -t $SCREEN_NAME"
  record_codex_pid "$CHANNEL_ID"
}

IFS=$'\t' read -r PATH_DIR SCREEN_NAME CHANNEL_ID WS_PORT DISCORD_USER_IDS TEXT_REPLY_FALLBACK_FLAG CODEX_MODEL_VALUE CODEX_REASONING_EFFORT_VALUE CODEX_SERVICE_TIER_VALUE <<< "$(python3 -c "
import json, os
r = json.load(open('$REGISTRY'))
p = r['projects']['$PROJECT']
allowed_user_ids = [r['discord_user_id']] + list(p.get('guest_user_ids') or [])
print('\t'.join([
    os.path.expanduser(p['path']),
    p['screen_name'],
    p['channel_id'],
    str(p.get('ws_port', 18300)),
    ','.join(dict.fromkeys(str(user_id) for user_id in allowed_user_ids if str(user_id))),
    '1' if p.get('text_reply_fallback') is True else '__NONE__',
    (p.get('codex_model') or p.get('model') or '__NONE__'),
    (p.get('codex_reasoning_effort') or p.get('model_reasoning_effort') or '__NONE__'),
    (p.get('codex_service_tier') or p.get('service_tier') or '__NONE__'),
]))
")"

if CODEX_HOME_DIR="$(python3 "$SCRIPT_DIR/resolve-codex-home.py" "$REGISTRY" "$PROJECT")"; then
  :
else
  resolver_status=$?
  exit "$resolver_status"
fi

if tmux has-session -t "=$SCREEN_NAME" 2>/dev/null; then
  echo "Session '$SCREEN_NAME' is already running."
  exit 0
fi

EXISTING_PIDS="$(find_codex_listener_pids "$CHANNEL_ID" "$WS_PORT")"
if [[ -n "$EXISTING_PIDS" ]]; then
  echo "Refusing to start '$PROJECT': existing Codex Discord bridge process(es) already use channel $CHANNEL_ID or port $WS_PORT:"
  echo "$EXISTING_PIDS" | sed 's/^/  /'
  echo "Run scripts/stop-session.sh '$PROJECT' first, then retry."
  exit 1
fi

# Remove stale discord MCP entries from the selected Codex home config
# (they get re-registered per session)
python3 - "$CODEX_HOME_DIR" <<'PY' 2>/dev/null || true
import os
import sys
codex_home = os.path.expanduser(sys.argv[1])
config_path = os.path.join(codex_home, 'config.toml')
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
PY

[[ "$TEXT_REPLY_FALLBACK_FLAG" == "__NONE__" ]] && TEXT_REPLY_FALLBACK_FLAG=""
[[ "$CODEX_MODEL_VALUE" == "__NONE__" ]] && CODEX_MODEL_VALUE=""
[[ "$CODEX_REASONING_EFFORT_VALUE" == "__NONE__" ]] && CODEX_REASONING_EFFORT_VALUE=""
[[ "$CODEX_SERVICE_TIER_VALUE" == "__NONE__" ]] && CODEX_SERVICE_TIER_VALUE="default"
AUDIO_TRANSCRIPTION_ENV=""
TRANSCRIBE_AUDIO_FLAG="${CODEX_BRIDGE_TRANSCRIBE_AUDIO:-${USE_AUDIO_TRANSCRIPTION_IN_BRIDGE:-}}"
if [[ -n "$TRANSCRIBE_AUDIO_FLAG" ]]; then
  AUDIO_TRANSCRIPTION_ENV=" CODEX_BRIDGE_TRANSCRIBE_AUDIO='${TRANSCRIBE_AUDIO_FLAG}'"
fi
TEXT_REPLY_FALLBACK_ENV=""
if [[ "$TEXT_REPLY_FALLBACK_FLAG" == "1" ]]; then
  TEXT_REPLY_FALLBACK_ENV=" CODEX_BRIDGE_TEXT_REPLY_FALLBACK='1'"
fi
CODEX_MODEL_ENV=""
if [[ -n "$CODEX_MODEL_VALUE" ]]; then
  CODEX_MODEL_ENV=" CODEX_MODEL='${CODEX_MODEL_VALUE}'"
fi
CODEX_REASONING_ENV=""
if [[ -n "$CODEX_REASONING_EFFORT_VALUE" ]]; then
  CODEX_REASONING_ENV=" CODEX_REASONING_EFFORT='${CODEX_REASONING_EFFORT_VALUE}'"
fi
CODEX_SERVICE_TIER_ENV=" CODEX_SERVICE_TIER='${CODEX_SERVICE_TIER_VALUE}' CODEX_RESUME_THREAD_ID='${RESUME_THREAD_ID}'"

start_router_session
