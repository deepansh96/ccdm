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

# The listener is found by its launch-scoped env var: DISCORD_STATE_DIR for
# pool launches, CCDM_ROUTER_KEY_FILE for router launches.
record_claude_pid() {
  local state_dir="$1"
  local claude_home="$2"
  local env_name="${3:-DISCORD_STATE_DIR}"
  python3 - "$REGISTRY" "$PROJECT" "$state_dir" "$claude_home" "$env_name" <<'PY'
import json
import os
import re
import shlex
import subprocess
import sys
import time

registry_path, project, state_arg = sys.argv[1:4]
claude_home = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else "~/.claude"
env_name = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else "DISCORD_STATE_DIR"
target = os.path.normpath(os.path.expanduser(state_arg))
env_re = re.compile(re.escape(env_name) + r"""=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")

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
        or ("--dangerously-load-development-channels" in argv
            and ("server:discord" in argv or "server:ccdm" in argv))
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

# Router-transport listeners carry this launch's key file path (never the key)
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

# Router transport: the session holds no Discord token. A fresh launch key
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
  python3 - "$PROJECT" "$router_state" "$launch_dir" "$SCRIPT_DIR/ccdm-channel-server.js" <<'PY' || return 1
import json
import os
import secrets
import sys
from pathlib import Path

project, router_state, launch_dir, server_script = sys.argv[1:5]
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
config = {"mcpServers": {"ccdm": {
    "command": "node",
    "args": [server_script],
    "env": {
        "CCDM_CLAUDE_PROJECT": project,
        "CCDM_ROUTER_STATE_DIR": router_state,
        "CCDM_ROUTER_KEY_FILE": str(key_file),
        "CCDM_CHANNEL_READY_FILE": str(launch / "ready.json"),
    },
}}}
write_private(launch / "mcp.json", json.dumps(config, indent=2) + "\n")
# The official Discord plugin must not load beside the CCDM channel.
write_private(launch / "settings.json", json.dumps({"enabledPlugins": {"discord@claude-plugins-official": False}}, indent=2) + "\n")
# Replacing the key revokes whichever session still holds the old one.
write_private(key_file, secrets.token_urlsafe(32) + "\n")
PY

  tmux new-session -d -s "$SCREEN_NAME" -- zsh -ic "cd '$PATH_DIR' && CCDM_ROUTER_KEY_FILE='$key_file'$CONFIG_DIR_ENV claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions --mcp-config '$mcp_config' --settings '$settings'$MODEL_FLAG$EFFORT_FLAG"
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
  record_claude_pid "$key_file" "$CLAUDE_HOME" CCDM_ROUTER_KEY_FILE
}

# Read project config and resolve bot's state_dir from the pool
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
transport = 'router' if p.get('transport') == 'router' else 'pool'
# Router projects have no pool bot and no bot state directory.
if transport == 'router':
    state_dir = '__NONE__'
else:
    bot = next(b for b in r['pool'] if b['id'] == p['bot_id'])
    state_dir = os.path.expanduser(bot['state_dir'])
claude_home = os.path.expanduser(p['claude_home']) if p.get('claude_home') else '__NONE__'
print(os.path.expanduser(p['path']) + '\t' + state_dir + '\t' + p['screen_name'] + '\t' + (p.get('model') or '__NONE__') + '\t' + effort + '\t' + claude_home + '\t' + str(p['channel_id']) + '\t' + transport)
PY
)" || exit $?
IFS=$'\t' read -r PATH_DIR STATE_DIR SCREEN_NAME MODEL CLAUDE_EFFORT CLAUDE_HOME CHANNEL_ID TRANSPORT <<< "$PROJECT_CONFIG_FIELDS"

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

if [[ "$TRANSPORT" == "router" ]]; then
  start_router_session
  exit $?
fi

EXISTING_PIDS="$(find_claude_listener_pids "$STATE_DIR")"
if [[ -n "$EXISTING_PIDS" ]]; then
  echo "Refusing to start '$PROJECT': existing Claude Discord listener process(es) already use $STATE_DIR:"
  echo "$EXISTING_PIDS" | sed 's/^/  /'
  echo "Run scripts/stop-session.sh '$PROJECT' first, then retry."
  exit 1
fi

MCP_CONFIG="$STATE_DIR/ccdm-message-export-mcp.json"
REMINDER_ADAPTER="${CCDM_CLAUDE_REMINDER_ADAPTER:-0}"
# Only the adapter of this launch may prove a filtered Claude transport; a
# plain launch runs the unfiltered official plugin and stays unsupported.
clear_claude_capability_marker
SETTINGS_FLAG=""
CHANNEL_FLAG="--channels plugin:discord@claude-plugins-official"
if [[ "$REMINDER_ADAPTER" == "1" ]]; then
  CHANNEL_FLAG="--dangerously-load-development-channels server:discord"
  SETTINGS_FLAG=" --settings '$STATE_DIR/ccdm-conversation-reminder-hooks.json'"
fi
python3 - "$MCP_CONFIG" "$SCRIPT_DIR/discord-mcp-server.js" "$CHANNEL_ID" "$STATE_DIR" "$REMINDER_ADAPTER" "$ROOT_DIR" "$PROJECT" "$CLAUDE_HOME" <<'PY'
import json
import os
import sys
import base64
import re
import subprocess
from pathlib import Path
from uuid import uuid4

config_path, server_script, channel_id, state_dir, adapter_enabled, root_dir, project, claude_home = sys.argv[1:9]
os.makedirs(os.path.dirname(config_path), exist_ok=True)
config = {
    "mcpServers": {
        "discord-message-export": {
            "command": "node",
            "args": [server_script],
            "env": {
                "CHANNEL_ID": channel_id,
                "DISCORD_STATE_DIR": state_dir,
                "DISCORD_MCP_EXPORT_ONLY": "1",
            },
        },
    },
}
if adapter_enabled == "1":
    version = subprocess.run(["claude", "--version"], capture_output=True, text=True)
    # Claude Code auto-updates, so accept any 2.x release from the first tested one;
    # the MCP proxy still rejects a changed plugin server identity or capabilities.
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:\s|$)", version.stdout.strip())
    parsed = tuple(int(part) for part in match.groups()) if match else None
    if version.returncode != 0 or not parsed or parsed[0] != 2 or parsed < (2, 1, 281):
        sys.exit("Claude reminder adapter: unsupported Claude Code version (requires 2.x from 2.1.281)")
    registry = json.loads((Path(root_dir) / "registry.json").read_text())
    bot_id = registry["projects"][project]["bot_id"]
    bots = [bot for bot in registry["pool"] if bot.get("id") == bot_id]
    if len(bots) != 1 or not bots[0].get("app_id"):
        sys.exit("Claude reminder adapter requires an unambiguous assigned bot app ID")
    root_app_id = registry.get("root_bot_app_id") or ""
    root_env = Path(os.environ.get("ROOT_DISCORD_STATE_DIR") or Path.home() / ".claude" / "channels" / "discord") / ".env"
    if root_env.is_file():
        match = re.search(r"^DISCORD_BOT_TOKEN=(\S+)", root_env.read_text(), re.MULTILINE)
        if match:
            encoded_id = match.group(1).split(".")[0]
            try:
                root_app_id = base64.urlsafe_b64decode(encoded_id + "=" * (-len(encoded_id) % 4)).decode("ascii")
            except (ValueError, UnicodeDecodeError):
                pass
    if not root_app_id:
        sys.exit("Claude reminder adapter requires root bot identity")
    selected_home = Path(claude_home) if claude_home else Path.home() / ".claude"
    plugin_dir = selected_home / "plugins" / "cache" / "claude-plugins-official" / "discord" / "0.0.4"
    if not (plugin_dir / "server.ts").is_file():
        sys.exit("Claude reminder adapter requires installed official Discord plugin 0.0.4")
    reminder_dir = Path(os.environ.get("CCDM_REMINDER_STATE_DIR") or Path.home() / ".local" / "state" / "ccdm" / "conversation-reminders")
    launch_id = str(uuid4())
    env = {
        "CCDM_REMINDER_PROJECT_ROOT": root_dir,
        "CCDM_REMINDER_STATE_DIR": str(reminder_dir),
        "CCDM_REMINDER_RECEIPTS_DIR": str(reminder_dir / "claude-receipts"),
        "CCDM_CLAUDE_PROJECT": project,
        "CCDM_CLAUDE_CHANNEL_ID": channel_id,
        "CCDM_CLAUDE_BOT_APP_ID": str(bots[0]["app_id"]),
        "CCDM_CLAUDE_ROOT_APP_ID": str(root_app_id),
        "CCDM_CLAUDE_PLUGIN_ROOT": str(plugin_dir),
        "CCDM_CLAUDE_LAUNCH_ID": launch_id,
        "CCDM_CLAUDE_HOOK_SETTINGS": str(Path(state_dir) / "ccdm-conversation-reminder-hooks.json"),
    }
    config["mcpServers"]["discord"] = {
        "command": "node",
        "args": [str(Path(root_dir) / "scripts" / "claude-reminder-channel.js")],
        "env": env,
    }
    # Hook commands are command hooks: no prompt/agent hook can invoke a model.
    hook = str(Path(root_dir) / "scripts" / "claude-reminder-hook.js")
    settings = {"enabledPlugins": {"discord@claude-plugins-official": False},
                "hooks": {event: [{"hooks": [{"type": "command", "command": f"node '{hook}'"}]}]
                          for event in ("SessionStart", "Stop", "StopFailure", "SessionEnd")}}
    settings_path = Path(state_dir) / "ccdm-conversation-reminder-hooks.json"
    with settings_path.open("w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    os.chmod(settings_path, 0o600)
    # The Claude process inherits launch-scoped context, including the same ID
    # as its channel server and its command hooks.
    with (Path(state_dir) / "ccdm-conversation-reminder-env.json").open("w") as f:
        json.dump(env, f)
    os.chmod(Path(state_dir) / "ccdm-conversation-reminder-env.json", 0o600)
with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
os.chmod(config_path, 0o600)
PY

REMINDER_ENV=""
if [[ "$REMINDER_ADAPTER" == "1" ]]; then
  REMINDER_ENV="$(python3 - "$STATE_DIR/ccdm-conversation-reminder-env.json" <<'PY'
import json,sys
e=json.load(open(sys.argv[1]))
print(''.join(f" {k}='{v}'" for k,v in e.items()))
PY
)"
fi
tmux new-session -d -s "$SCREEN_NAME" -- zsh -ic "cd '$PATH_DIR' && DISCORD_STATE_DIR='$STATE_DIR'$CONFIG_DIR_ENV$REMINDER_ENV claude $CHANNEL_FLAG --dangerously-skip-permissions --mcp-config '$MCP_CONFIG'$SETTINGS_FLAG$MODEL_FLAG$EFFORT_FLAG"
echo "Started Discord bot in tmux session '$SCREEN_NAME'"
echo "Attach with: tmux attach -t $SCREEN_NAME"
record_claude_pid "$STATE_DIR" "$CLAUDE_HOME"
