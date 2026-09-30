#!/bin/zsh
# Restart the root agent as a Codex bridge in root mode, a Router client.
# The bridge holds root's Router key and no Discord token; root channels and
# allowed users come from the registry. Root admin scripts keep reading the
# root token from root's Discord state directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="$SCRIPT_DIR/registry.json"
ROOT_STATE_DIR="${ROOT_DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}"
ROUTER_STATE_DIR="${CCDM_ROUTER_STATE_DIR:-$HOME/.local/state/ccdm/router}"
ROOT_KEY_FILE="$ROUTER_STATE_DIR/keys/.root.key"
ROOT_LAUNCH_DIR="$ROUTER_STATE_DIR/launches/.root"
ROOT_READY_FILE="$ROOT_LAUNCH_DIR/ready.json"

CHANNEL_ID="${1:-${ROOT_CODEX_CHANNEL_ID:-}}"
WS_PORT="${ROOT_CODEX_WS_PORT:-18399}"

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
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  done
}

find_root_listener_pids() {
  python3 - "$ROOT_STATE_DIR" "$WS_PORT" "$BOT_APP_ID" "$ROOT_KEY_FILE" <<'PY'
import os
import re
import shlex
import subprocess
import sys

state_dir, ws_port, bot_app_id, root_key_file = sys.argv[1:5]
target_state_dir = os.path.normpath(os.path.expanduser(state_dir))
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
    env_re = re.compile(rf'''(?:^|\s){re.escape(name)}=(?:"([^"]*)"|'([^']*)'|([^\s]+))''')
    for match in env_re.finditer(command):
        found = next(group for group in match.groups() if group is not None)
        if found == value:
            return True
    return False

def has_target_state(command: str) -> bool:
    env_re = re.compile(r'''(?:^|\s)DISCORD_STATE_DIR=(?:"([^"]*)"|'([^']*)'|([^\s]+))''')
    for match in env_re.finditer(command):
        found = next(group for group in match.groups() if group is not None)
        if os.path.normpath(os.path.expanduser(found)) == target_state_dir:
            return True
    return False

def is_discord_plugin_path(value: str) -> bool:
    plugin_path = os.path.normpath(os.path.expanduser(value))
    roots = (
        "claude-plugins-official/discord",
        "claude-plugins-official/external_plugins/discord",
    )
    return any(plugin_path.endswith(f"/{root}") or f"/{root}/" in plugin_path for root in roots)

def is_claude_listener(command: str) -> bool:
    if not has_target_state(command):
        return False
    argv = command_argv(command)
    if not argv:
        return False
    exe = os.path.basename(argv[0])
    if exe == "claude" and "--channels" in argv and any(
        arg.startswith("plugin:discord") for arg in argv
    ):
        return True
    if exe == "claude-channel-discord":
        return True
    if exe != "bun":
        return False
    for index, arg in enumerate(argv[:-1]):
        if arg == "--cwd" and is_discord_plugin_path(argv[index + 1]):
            return True
    plugin_root = re.search(r'''(?:^|\s)CLAUDE_PLUGIN_ROOT=(?:"([^"]*)"|'([^']*)'|([^\s]+))''', command)
    return (
        any(os.path.basename(arg) == "server.ts" for arg in argv[1:])
        and plugin_root is not None
        and is_discord_plugin_path(next(group for group in plugin_root.groups() if group is not None))
    )

def is_root_bridge(command: str) -> bool:
    argv = command_argv(command)
    return (
        len(argv) >= 2
        and os.path.basename(argv[0]) == "node"
        and os.path.normpath(argv[1]).endswith("scripts/codex-bridge.js")
        and (
            (bot_app_id and has_env(command, "BOT_APP_ID", bot_app_id))
            or has_env(command, "WS_PORT", ws_port)
            or has_env(command, "CCDM_ROUTER_KEY_FILE", root_key_file)
        )
    )

def is_app_server(command: str) -> bool:
    argv = command_argv(command)
    return (
        bool(argv)
        and os.path.basename(argv[0]) in {"node", "codex"}
        and "app-server" in argv
        and f"ws://127.0.0.1:{ws_port}" in argv
    )

for line in ps.splitlines():
    line = line.strip()
    if not line:
        continue
    pid_text, _, command = line.partition(" ")
    if not pid_text.isdigit() or "ps axeww" in command or "python3 -" in command:
        continue
    if is_claude_listener(command) or is_root_bridge(command) or is_app_server(command):
        print(pid_text)
PY
}

# Unit-separated, so an empty field (no root_bot_app_id) keeps its place.
IFS=$'\x1f' read -r CHANNEL_ID REGISTRY_USER_ID REGISTRY_ROOT_APP_ID REGISTRY_ALLOWED_USER_IDS <<< "$(python3 - "$REGISTRY" "$CHANNEL_ID" <<'PY'
import json
import sys

registry_path, channel_id = sys.argv[1:3]
registry = json.load(open(registry_path))
root_channels = [str(channel) for channel in registry.get("root_channels") or []]
if not root_channels:
    sys.exit(
        f"No root_channels in {registry_path}. "
        "Run `node scripts/router.js migrate-root-config` to move them from root's access.json."
    )
if not channel_id:
    if len(root_channels) != 1:
        sys.exit(
            f"Usage: restart-root-codex-agent.sh <channel_id> (or set ROOT_CODEX_CHANNEL_ID)\n"
            "Refusing to guess because the registry lists several root channels."
        )
    channel_id = root_channels[0]
if channel_id not in root_channels:
    sys.exit(f"Root channel {channel_id} is not in root_channels in {registry_path}.")
owner = str(registry.get("discord_user_id") or "")
seen = set()
allowed = []
for user_id in [owner, *(registry.get("root_allowed_user_ids") or [])]:
    user_id = str(user_id).strip()
    if user_id and user_id not in seen:
        seen.add(user_id)
        allowed.append(user_id)
print("\x1f".join([
    channel_id,
    owner,
    str(registry.get("root_bot_app_id") or ""),
    ",".join(allowed),
]))
PY
)"
[[ -n "$CHANNEL_ID" ]] || exit 1

if CODEX_HOME_DIR="$(python3 "$SCRIPT_DIR/scripts/resolve-codex-home.py" "$REGISTRY" --root)"; then
  :
else
  resolver_status=$?
  exit "$resolver_status"
fi

ALLOWED_USER_IDS="${ROOT_CODEX_ALLOWED_USER_IDS:-$REGISTRY_ALLOWED_USER_IDS}"
if [[ -z "$ALLOWED_USER_IDS" ]]; then
  echo "No allowed Discord user IDs found. Set ROOT_CODEX_ALLOWED_USER_IDS." >&2
  exit 1
fi

# Only used to strip root's own mention from message text; the Router decides
# which messages address root.
BOT_APP_ID="${ROOT_CODEX_BOT_APP_ID:-$REGISTRY_ROOT_APP_ID}"

# A restart rotates root's key and stops the running root, and the new root
# can only say hello to a live Router. While the Router is down the running
# root (perhaps on its emergency direct gateway) is the only way to reach
# root, so leave it and its key alone. The check is read-only and bounded.
if ! python3 - "$SCRIPT_DIR/scripts/router.js" <<'PY'
import os
import subprocess
import sys

node = os.environ.get("CCDM_ROUTER_NODE") or "node"
try:
    status = subprocess.run([node, sys.argv[1], "status"], stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True, timeout=15)
except (OSError, subprocess.TimeoutExpired) as error:
    sys.exit(f"Router status check failed: {error}")
if status.returncode:
    sys.exit(status.stderr.strip() or "Router status check failed")
PY
then
  echo "The Router is not answering, so root was not restarted: the running root and its key are unchanged. Start the Router (scripts/install-router-service.sh, or node scripts/router.js serve) and retry." >&2
  exit 1
fi

# Kill the current root_agent tmux session, whether it is Claude or Codex.
if tmux has-session -t root_agent 2>/dev/null; then
  PANE_PID="$(tmux display-message -t root_agent -p '#{pane_pid}' 2>/dev/null || true)"
  if [[ -n "$PANE_PID" ]]; then
    pkill -TERM -P "$PANE_PID" 2>/dev/null || true
    sleep 1
  fi
  tmux kill-session -t root_agent 2>/dev/null || true
  sleep 2
  if tmux has-session -t root_agent 2>/dev/null; then
    tmux kill-session -t root_agent 2>/dev/null || true
    sleep 1
  fi
fi

ORPHAN_PIDS="$(find_root_listener_pids)"
if [[ -n "$ORPHAN_PIDS" ]]; then
  echo "Cleaning remaining root listener process(es):"
  echo "$ORPHAN_PIDS" | sed 's/^/  /'
  terminate_pids "${(@f)ORPHAN_PIDS}"
fi
# Replacing root's key revokes the root session still holding the old one.
python3 - "$ROUTER_STATE_DIR" "$ROOT_LAUNCH_DIR" <<'PY'
import os
import secrets
import sys
from pathlib import Path

router_state, launch_dir = map(Path, sys.argv[1:3])
keys_dir = router_state / "keys"
for directory in (router_state, keys_dir, launch_dir.parent, launch_dir):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
# A previous launch's outcome is wrong for this one.
(launch_dir / "ready.json").unlink(missing_ok=True)
key_file = keys_dir / ".root.key"
tmp = key_file.with_name(f".{key_file.name}.{os.getpid()}.tmp")
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(secrets.token_urlsafe(32) + "\n")
os.replace(tmp, key_file)
PY

if ! tmux new-session -d -s root_agent -- zsh -ic "cd '$SCRIPT_DIR' && CODEX_HOME='$CODEX_HOME_DIR' CCDM_ROUTER_ROLE='root' CCDM_ROUTER_STATE_DIR='$ROUTER_STATE_DIR' CCDM_ROUTER_KEY_FILE='$ROOT_KEY_FILE' CCDM_CHANNEL_READY_FILE='$ROOT_READY_FILE' CHANNEL_ID='$CHANNEL_ID' PROJECT_DIR='$SCRIPT_DIR' WS_PORT='$WS_PORT' ALLOWED_USER_IDS='$ALLOWED_USER_IDS' ROOT_BOT_APP_ID='$BOT_APP_ID' BOT_APP_ID='$BOT_APP_ID' node scripts/codex-bridge.js"; then
  echo "Failed to create tmux session 'root_agent'" >&2
  python3 -c 'import sys; from pathlib import Path; Path(sys.argv[1]).unlink(missing_ok=True)' "$ROOT_KEY_FILE"
  exit 1
fi

# The bridge reports its Router hello outcome once Codex is up and bootstrapped.
if ! python3 - "$ROOT_READY_FILE" <<'PY'
import json
import os
import subprocess
import sys
import time

ready_file = sys.argv[1]
deadline = time.monotonic() + float(os.environ.get("CCDM_CODEX_LAUNCH_TIMEOUT_S") or 120)
while time.monotonic() < deadline:
    try:
        with open(ready_file) as f:
            outcome = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        if subprocess.run(["tmux", "has-session", "-t", "=root_agent"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            sys.exit("Root Codex launch failed: bridge exited before saying hello")
        time.sleep(0.2)
        continue
    if outcome.get("ok"):
        print("Root bridge connected to the Router")
        sys.exit(0)
    sys.exit(f"Root Codex launch failed: {outcome.get('error')}")
sys.exit("Root Codex launch failed: the bridge never said hello to the Router")
PY
then
  echo "Root launch failed; cleaning up" >&2
  tmux kill-session -t "=root_agent" 2>/dev/null || true
  LEFTOVER_PIDS="$(find_root_listener_pids)"
  [[ -z "$LEFTOVER_PIDS" ]] || terminate_pids "${(@f)LEFTOVER_PIDS}"
  python3 -c 'import sys; from pathlib import Path; [Path(p).unlink(missing_ok=True) for p in sys.argv[1:]]' \
    "$ROOT_KEY_FILE" "$ROOT_READY_FILE"
  exit 1
fi

echo "Restarted root Codex agent in tmux session 'root_agent'"
echo "Channel: $CHANNEL_ID"
echo "Attach with: tmux attach -t root_agent"
