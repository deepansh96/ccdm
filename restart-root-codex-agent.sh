#!/bin/zsh
# Restart the root Discord bot as a Codex bridge for one channel.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="$SCRIPT_DIR/registry.json"
ROOT_STATE_DIR="${ROOT_DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}"
ENV_FILE="$ROOT_STATE_DIR/.env"
ACCESS_FILE="$ROOT_STATE_DIR/access.json"

CHANNEL_ID="${1:-${ROOT_CODEX_CHANNEL_ID:-}}"
WS_PORT="${ROOT_CODEX_WS_PORT:-18399}"
BOT_DISPLAY_NAME="${ROOT_CODEX_BOT_DISPLAY_NAME:-root-codex}"

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
  python3 - "$ROOT_STATE_DIR" "$WS_PORT" "$BOT_APP_ID" <<'PY'
import os
import re
import shlex
import subprocess
import sys

state_dir, ws_port, bot_app_id = sys.argv[1:4]
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
        and (has_env(command, "BOT_APP_ID", bot_app_id) or has_env(command, "WS_PORT", ws_port))
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

if [[ -z "$CHANNEL_ID" && -f "$ACCESS_FILE" ]]; then
  CHANNEL_ID="$(python3 - "$ACCESS_FILE" <<'PY'
import json
import sys

groups = json.load(open(sys.argv[1])).get("groups", {})
root_channels = [
    channel_id
    for channel_id, config in groups.items()
    if config.get("requireMention") is False
]
if len(root_channels) == 1:
    print(root_channels[0])
PY
)"
fi

if [[ -z "$CHANNEL_ID" ]]; then
  echo "Usage: $0 <channel_id> (or set ROOT_CODEX_CHANNEL_ID)" >&2
  echo "Refusing to guess because this root bot can be allowed in multiple channels." >&2
  exit 1
fi

if [[ ! -f "$ACCESS_FILE" ]]; then
  echo "Missing root access file: $ACCESS_FILE" >&2
  exit 1
fi

if ! python3 - "$ACCESS_FILE" "$CHANNEL_ID" <<'PY'
import json
import sys

access_file, channel_id = sys.argv[1:3]
groups = json.load(open(access_file)).get("groups", {})
channel = groups.get(channel_id)
if not isinstance(channel, dict) or channel.get("requireMention") is not False:
    print(
        f"Root channel {channel_id} is not configured as a no-mention channel in {access_file}. "
        "Add it to groups with requireMention set to false before restarting.",
        file=sys.stderr,
    )
    sys.exit(1)
PY
then
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing root bot env file: $ENV_FILE" >&2
  exit 1
fi

BOT_TOKEN="$(python3 - "$ENV_FILE" <<'PY'
import sys

for line in open(sys.argv[1]):
    if line.startswith("DISCORD_BOT_TOKEN="):
        print(line.split("=", 1)[1].strip())
        break
PY
)"

if [[ -z "$BOT_TOKEN" ]]; then
  echo "DISCORD_BOT_TOKEN is missing from $ENV_FILE" >&2
  exit 1
fi

IFS=$'\t' read -r REGISTRY_USER_ID GUILD_ID REGISTRY_ROOT_APP_ID <<< "$(python3 - "$REGISTRY" <<'PY'
import json
import sys

registry = json.load(open(sys.argv[1]))
print("\t".join([
    str(registry.get("discord_user_id") or ""),
    str(registry.get("guild_id") or ""),
    str(registry.get("root_bot_app_id") or ""),
]))
PY
)"

if CODEX_HOME_DIR="$(python3 "$SCRIPT_DIR/scripts/resolve-codex-home.py" "$REGISTRY" --root)"; then
  :
else
  resolver_status=$?
  exit "$resolver_status"
fi

ALLOWED_USER_IDS="${ROOT_CODEX_ALLOWED_USER_IDS:-$(python3 - "$REGISTRY_USER_ID" "$ACCESS_FILE" <<'PY'
import json
import sys

ids = [sys.argv[1]]
access_path = sys.argv[2]
access = json.load(open(access_path))
ids.extend(access.get("allowFrom") or [])
seen = set()
deduped = []
for user_id in ids:
    user_id = str(user_id).strip()
    if user_id and user_id not in seen:
        seen.add(user_id)
        deduped.append(user_id)
print(",".join(deduped))
PY
)}"

if [[ -z "$ALLOWED_USER_IDS" ]]; then
  echo "No allowed Discord user IDs found. Set ROOT_CODEX_ALLOWED_USER_IDS." >&2
  exit 1
fi

BOT_APP_ID="${ROOT_CODEX_BOT_APP_ID:-$(python3 - "$BOT_TOKEN" "$REGISTRY_ROOT_APP_ID" <<'PY'
import base64
import sys

token = sys.argv[1]
fallback = sys.argv[2]
try:
    token_id = token.split(".", 1)[0]
    token_id += "=" * ((4 - len(token_id) % 4) % 4)
    print(base64.urlsafe_b64decode(token_id).decode())
except Exception:
    print(fallback)
PY
)}"

if [[ -z "$BOT_APP_ID" ]]; then
  echo "Could not determine root bot app ID. Set ROOT_CODEX_BOT_APP_ID." >&2
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

if ! tmux new-session -d -s root_agent -- zsh -ic "cd '$SCRIPT_DIR' && CODEX_HOME='$CODEX_HOME_DIR' BOT_TOKEN='$BOT_TOKEN' CHANNEL_ID='$CHANNEL_ID' PROJECT_DIR='$SCRIPT_DIR' WS_PORT='$WS_PORT' ALLOWED_USER_IDS='$ALLOWED_USER_IDS' GUILD_ID='$GUILD_ID' ROOT_BOT_APP_ID='$BOT_APP_ID' BOT_APP_ID='$BOT_APP_ID' BOT_DISPLAY_NAME='$BOT_DISPLAY_NAME' ROOT_MULTI_CHANNEL='1' ROOT_ACCESS_FILE='$ACCESS_FILE' node scripts/codex-bridge.js"; then
  echo "Failed to create tmux session 'root_agent'" >&2
  exit 1
fi

echo "Restarted root Codex agent in tmux session 'root_agent'"
echo "Channel: $CHANNEL_ID"
echo "Attach with: tmux attach -t root_agent"
