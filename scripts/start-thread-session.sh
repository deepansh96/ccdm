#!/bin/zsh
# Usage: ./scripts/start-thread-session.sh <project> <thread_id> --provider claude|codex
#          [--account <alias>] [--model <model>] [--effort <effort>] [--resume <id>]
# Starts one Thread Conversation's session, served through the Router as the
# `thread` role. The Thread Supervisor runs it; on success the last stdout
# line is {"pid", "provider_conversation_id", "tmux", "provider_home"}, and
# everything else goes to stderr.
#
# Each launch writes a fresh key, keys/.thread-<thread_id>.key, and a launch
# directory, launches/<project>/threads/<thread_id>/, and runs in tmux
# `<screen>-t-<last 6 of the thread id>`. A launch is refused while a process
# still carries that key path; a failed launch removes its key, launch
# directory and tmux session. CCDM_THREAD_BOOTSTRAP_FILE, from the supervisor,
# names the bootstrap file the channel server (or Codex bridge) waits for.
#
# A Codex thread runs codex-bridge.js in thread mode, with its own app-server
# on CCDM_THREAD_WS_PORT, the port the supervisor allocated. Its account alias
# takes the place of the project's codex_account in resolve-codex-home.py, its
# provider conversation id is the Codex thread uuid, and its last stdout line
# also carries `ws_port`.
#
# --resume continues the thread's provider conversation (`claude --resume`,
# or the bridge's Codex thread uuid) in the same home and cwd. A missing
# transcript or rollout fails the start before any key or tmux session; it
# never starts a fresh conversation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="${CCDM_REGISTRY_PATH:-$ROOT_DIR/registry.json}"

usage() {
  echo "Usage: $0 <project> <thread_id> --provider claude|codex [--account <alias>] [--model <model>] [--effort <effort>] [--resume <id>]" >&2
  exit 2
}

PROJECT="${1:-}"
THREAD_ID="${2:-}"
(( $# >= 2 )) || usage
shift 2
PROVIDER=""
ACCOUNT=""
MODEL=""
EFFORT=""
RESUME_ID=""
while (( $# > 0 )); do
  (( $# >= 2 )) || usage
  case "$1" in
    --provider) PROVIDER="$2" ;;
    --account) ACCOUNT="$2" ;;
    --model) MODEL="$2" ;;
    --effort) EFFORT="$2" ;;
    --resume) RESUME_ID="$2" ;;
    *) usage ;;
  esac
  shift 2
done

if [[ ! "$THREAD_ID" =~ '^[0-9A-Za-z_-]+$' ]]; then
  echo "Invalid thread id: '$THREAD_ID'" >&2
  exit 2
fi
case "$PROVIDER" in
  claude|codex) ;;
  *) usage ;;
esac
if [[ -n "$RESUME_ID" && ! "$RESUME_ID" =~ '^[0-9A-Za-z_-]+$' ]]; then
  echo "Invalid conversation id to resume: '$RESUME_ID'" >&2
  exit 2
fi

# The project's settings, with the thread's overrides applied. An account is
# an alias in `claude_accounts` (or `codex_accounts`), never a path; without
# one the project's `claude_home` applies, then the default home (for Codex,
# the project's own Codex Home).
if [[ "$PROVIDER" == "claude" ]]; then
LAUNCH_FIELDS="$(python3 - "$REGISTRY" "$PROJECT" "$ACCOUNT" "$MODEL" "$EFFORT" <<'PY'
import json, os, sys
registry_path, project, account, model, effort = sys.argv[1:6]
registry = json.load(open(registry_path))
entry = (registry.get("projects") or {}).get(project)
if not isinstance(entry, dict) or not project or "/" in project or project.startswith("."):
    sys.exit(f"Unknown project '{project}'")
if not entry.get("webhook_id"):
    sys.exit(f"Project '{project}' has no webhook_id, so its thread replies could not be posted")
if account:
    accounts = registry.get("claude_accounts")
    home = accounts.get(account) if isinstance(accounts, dict) else None
    if not isinstance(home, str) or not home:
        sys.exit(f"Unknown Claude account alias '{account}'")
else:
    home = entry.get("claude_home") or ""
# The default home leaves CLAUDE_CONFIG_DIR unset, as Claude's own default.
config_dir = os.path.expanduser(home) if home else ""
home = config_dir or os.path.join(os.path.expanduser("~"), ".claude")
model = model or entry.get("model") or ""
effort = effort or entry.get("claude_effort") or ""
if effort and effort not in ("low", "medium", "high", "xhigh", "max"):
    sys.exit(f"Invalid effort '{effort}' (expected low, medium, high, xhigh, or max)")
fields = [os.path.expanduser(entry["path"]), entry["screen_name"], home, config_dir, model, effort]
print("\t".join(field or "__NONE__" for field in fields))
PY
)" || exit 1  # Python's reason is the last stderr line.
IFS=$'\t' read -r PATH_DIR SCREEN_NAME CLAUDE_HOME CONFIG_DIR MODEL EFFORT <<< "$LAUNCH_FIELDS"
CONFIG_DIR_ENV=""
[[ "$CONFIG_DIR" != "__NONE__" ]] && CONFIG_DIR_ENV=" CLAUDE_CONFIG_DIR='$CONFIG_DIR'"
[[ "$MODEL" == "__NONE__" ]] && MODEL=""
[[ "$EFFORT" == "__NONE__" ]] && EFFORT=""
else
LAUNCH_FIELDS="$(python3 - "$REGISTRY" "$PROJECT" "$MODEL" "$EFFORT" <<'PY'
import json, os, sys
registry_path, project, model, effort = sys.argv[1:5]
registry = json.load(open(registry_path))
entry = (registry.get("projects") or {}).get(project)
if not isinstance(entry, dict) or not project or "/" in project or project.startswith("."):
    sys.exit(f"Unknown project '{project}'")
if not entry.get("webhook_id"):
    sys.exit(f"Project '{project}' has no webhook_id, so its thread replies could not be posted")
allowed = [registry.get("discord_user_id")] + list(entry.get("guest_user_ids") or [])
fields = [
    os.path.expanduser(entry["path"]), entry["screen_name"],
    model or entry.get("codex_model") or entry.get("model") or "",
    effort or entry.get("codex_reasoning_effort") or entry.get("model_reasoning_effort") or "",
    entry.get("codex_service_tier") or entry.get("service_tier") or "default",
    "1" if entry.get("text_reply_fallback") is True else "",
    ",".join(dict.fromkeys(str(user_id) for user_id in allowed if user_id)),
]
print("\t".join(field or "__NONE__" for field in fields))
PY
)" || exit 1  # Python's reason is the last stderr line.
IFS=$'\t' read -r PATH_DIR SCREEN_NAME MODEL EFFORT SERVICE_TIER TEXT_REPLY_FALLBACK ALLOWED_USER_IDS <<< "$LAUNCH_FIELDS"
[[ "$MODEL" == "__NONE__" ]] && MODEL=""
[[ "$EFFORT" == "__NONE__" ]] && EFFORT=""
[[ "$TEXT_REPLY_FALLBACK" == "__NONE__" ]] && TEXT_REPLY_FALLBACK=""
ACCOUNT_ARGS=()
[[ -n "$ACCOUNT" ]] && ACCOUNT_ARGS=(--account "$ACCOUNT")
# An unknown alias is a start failure; the resolver's reason is its last stderr line.
CODEX_HOME_DIR="$(python3 "$SCRIPT_DIR/resolve-codex-home.py" "$REGISTRY" "$PROJECT" "${ACCOUNT_ARGS[@]}")" || exit 1
WS_PORT="${CCDM_THREAD_WS_PORT:-}"
if [[ ! "$WS_PORT" =~ '^[0-9]+$' ]]; then
  echo "No ws_port was allocated for Codex thread $THREAD_ID" >&2
  exit 1
fi
fi

# The conversation to resume must be on disk in this launch's home: Claude's
# transcript <home>/projects/<cwd, each non-alphanumeric character as "-">/<id>.jsonl,
# or a Codex rollout <CODEX_HOME>/sessions/**/rollout-*-<uuid>.jsonl.
if [[ -n "$RESUME_ID" ]]; then
  if [[ "$PROVIDER" == "claude" ]]; then
    RESUME_HOME="$CLAUDE_HOME"
  else
    RESUME_HOME="$CODEX_HOME_DIR"
  fi
  python3 - "$PROVIDER" "$PATH_DIR" "$RESUME_HOME" "$RESUME_ID" <<'PY' || exit 1  # The reason is the last stderr line.
import glob
import os
import re
import sys

provider, project_dir, home, conversation_id = sys.argv[1:5]
if provider == "claude":
    for cwd in dict.fromkeys([project_dir, os.path.realpath(project_dir)]):
        if os.path.isfile(os.path.join(home, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd), f"{conversation_id}.jsonl")):
            sys.exit(0)
    sys.exit(f"The Claude transcript for conversation {conversation_id} is missing from {home}")
if glob.glob(os.path.join(glob.escape(home), "sessions", "**", f"rollout-*-{conversation_id}.jsonl"), recursive=True):
    sys.exit(0)
sys.exit(f"The Codex rollout for conversation {conversation_id} is missing from {home}")
PY
fi

ROUTER_STATE="${CCDM_ROUTER_STATE_DIR:-$HOME/.local/state/ccdm/router}"
KEY_FILE="$ROUTER_STATE/keys/.thread-$THREAD_ID.key"
LAUNCH_DIR="$ROUTER_STATE/launches/$PROJECT/threads/$THREAD_ID"
TMUX_NAME="$SCREEN_NAME-t-${THREAD_ID[-6,-1]}"

# Thread listeners carry this launch's key file path (never the key) in their
# environment: the claude process and its CCDM channel server, or the Codex
# bridge and its app-server. Only that exact path matches, so project and
# sibling sessions never do.
find_thread_pids() {
  python3 - "$KEY_FILE" <<'PY'
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
    if exe == "codex":
        return "app-server" in argv
    return exe == "node" and any(os.path.basename(arg) in ("ccdm-channel-server.js", "codex-bridge.js")
                                 for arg in argv[1:])

for line in ps.splitlines():
    pid_text, _, command = line.strip().partition(" ")
    if not pid_text.isdigit() or "ps axeww" in command or "python3 -" in command:
        continue
    keys = [next(g for g in m.groups() if g is not None) for m in env_re.finditer(command)]
    if any(os.path.normpath(key) == target for key in keys) and is_listener(command):
        print(pid_text)
PY
}

EXISTING="$(find_thread_pids)"
if [[ -n "$EXISTING" ]]; then
  echo "Refusing to start thread $THREAD_ID: listener process(es) already use $KEY_FILE: ${(f)EXISTING}" >&2
  exit 1
fi
if tmux has-session -t "=$TMUX_NAME" 2>/dev/null; then
  echo "Refusing to start thread $THREAD_ID: tmux session '$TMUX_NAME' is already running" >&2
  exit 1
fi

cleanup_launch() {
  tmux kill-session -t "=$TMUX_NAME" 2>/dev/null || true
  local leftover
  leftover="$(find_thread_pids)"
  if [[ -n "$leftover" ]]; then
    kill -TERM ${(f)leftover} 2>/dev/null || true
  fi
  python3 - "$KEY_FILE" "$LAUNCH_DIR" <<'PY'
import shutil
import sys
from pathlib import Path

key_file, launch_dir = sys.argv[1:3]
Path(key_file).unlink(missing_ok=True)
shutil.rmtree(launch_dir, ignore_errors=True)
PY
}

fail() {
  echo "$1" >&2
  cleanup_launch
  exit 1
}

python3 - "$PROJECT" "$THREAD_ID" "$ROUTER_STATE" "$LAUNCH_DIR" "$SCRIPT_DIR/ccdm-channel-server.js" "$KEY_FILE" "$PROVIDER" <<'PY' || fail "The thread launch files could not be written"
import json
import os
import secrets
import shutil
import sys
from pathlib import Path

project, thread_id, router_state, launch_dir, server_script, key_file, provider = sys.argv[1:8]
launch = Path(launch_dir)
# A fresh launch directory: no previous launch's ready, context or bootstrap file.
shutil.rmtree(launch, ignore_errors=True)
for directory in (Path(router_state), Path(key_file).parent, launch.parent.parent.parent, launch.parent.parent,
                  launch.parent, launch):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)

def write_private(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)

write_private(Path(key_file), secrets.token_urlsafe(32) + "\n")
# A Codex bridge takes its settings from its tmux environment instead.
if provider == "codex":
    sys.exit(0)
env = {
    "CCDM_ROUTER_STATE_DIR": router_state,
    "CCDM_ROUTER_KEY_FILE": key_file,
    "CCDM_CHANNEL_READY_FILE": str(launch / "ready.json"),
    "CCDM_CLAUDE_PROJECT": project,
    "CCDM_THREAD_ID": thread_id,
    "CCDM_THREAD_PROVIDER": "claude",
    "CCDM_THREAD_BOOTSTRAP_FILE": os.environ.get("CCDM_THREAD_BOOTSTRAP_FILE") or str(launch / "bootstrap.json"),
}
if os.environ.get("CCDM_THREAD_BOOT_TIMEOUT_S"):
    env["CCDM_THREAD_BOOT_TIMEOUT_S"] = os.environ["CCDM_THREAD_BOOT_TIMEOUT_S"]
write_private(launch / "mcp.json", json.dumps({"mcpServers": {"ccdm": {
    "command": "node", "args": [server_script], "env": env,
}}}, indent=2) + "\n")
# The official Discord plugin must not load beside the CCDM channel.
write_private(launch / "settings.json", json.dumps({
    "enabledPlugins": {"discord@claude-plugins-official": False},
}, indent=2) + "\n")
PY

if [[ "$PROVIDER" == "codex" ]]; then
  CODEX_ENV=" CODEX_SERVICE_TIER='$SERVICE_TIER'"
  [[ -n "$MODEL" ]] && CODEX_ENV+=" CODEX_MODEL='$MODEL'"
  [[ -n "$EFFORT" ]] && CODEX_ENV+=" CODEX_REASONING_EFFORT='$EFFORT'"
  [[ -n "$TEXT_REPLY_FALLBACK" ]] && CODEX_ENV+=" CODEX_BRIDGE_TEXT_REPLY_FALLBACK='1'"
  TRANSCRIBE_AUDIO_FLAG="${CODEX_BRIDGE_TRANSCRIBE_AUDIO:-${USE_AUDIO_TRANSCRIPTION_IN_BRIDGE:-}}"
  [[ -n "$TRANSCRIBE_AUDIO_FLAG" ]] && CODEX_ENV+=" CODEX_BRIDGE_TRANSCRIBE_AUDIO='$TRANSCRIBE_AUDIO_FLAG'"
  BOOTSTRAP_FILE="${CCDM_THREAD_BOOTSTRAP_FILE:-$LAUNCH_DIR/bootstrap.json}"
  BOOT_TIMEOUT_ENV=""
  [[ -n "${CCDM_THREAD_BOOT_TIMEOUT_S:-}" ]] && BOOT_TIMEOUT_ENV=" CCDM_THREAD_BOOT_TIMEOUT_S='$CCDM_THREAD_BOOT_TIMEOUT_S'"
  [[ -n "$RESUME_ID" ]] && CODEX_ENV+=" CODEX_RESUME_THREAD_ID='$RESUME_ID'"
  # The bridge runs from this checkout; its app-server and turns run in the project path.
  if ! tmux new-session -d -s "$TMUX_NAME" -- zsh -ic "cd '$ROOT_DIR' && CODEX_HOME='$CODEX_HOME_DIR' CCDM_CODEX_PROJECT='$PROJECT' CCDM_ROUTER_STATE_DIR='$ROUTER_STATE' CCDM_ROUTER_KEY_FILE='$KEY_FILE' CCDM_CHANNEL_READY_FILE='$LAUNCH_DIR/ready.json' CHANNEL_ID='$THREAD_ID' PROJECT_DIR='$PATH_DIR' WS_PORT='$WS_PORT' ALLOWED_USER_IDS='$ALLOWED_USER_IDS' CCDM_THREAD_ID='$THREAD_ID' CCDM_THREAD_PROVIDER='codex' CCDM_THREAD_BOOTSTRAP_FILE='$BOOTSTRAP_FILE'$BOOT_TIMEOUT_ENV$CODEX_ENV node scripts/codex-bridge.js" >&2; then
    fail "tmux could not start the thread session"
  fi
  echo "Started Codex thread bridge in tmux session '$TMUX_NAME'" >&2

  # The bridge reports its Router hello outcome, and its Codex thread uuid,
  # once its app-server is up and its MCP server is registered.
  RESULT="$(python3 - "$TMUX_NAME" "$LAUNCH_DIR/ready.json" "$KEY_FILE" "$CODEX_HOME_DIR" "$WS_PORT" <<'PY'
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

screen, ready_file, key_file, codex_home, ws_port = sys.argv[1:6]
failure = Path(ready_file).with_name(".failure")
timeout = float(os.environ.get("CCDM_THREAD_BOOT_TIMEOUT_S") or 120)
deadline = time.monotonic() + timeout

def give_up(reason: str) -> None:
    failure.write_text(reason)
    sys.exit(reason)

outcome = None
while time.monotonic() < deadline:
    try:
        with open(ready_file) as f:
            outcome = json.load(f)
        break
    except (FileNotFoundError, json.JSONDecodeError):
        if subprocess.run(["tmux", "has-session", "-t", f"={screen}"], capture_output=True).returncode != 0:
            give_up("The Codex bridge exited before its Router hello")
        time.sleep(0.2)
if outcome is None:
    give_up(f"The Codex bridge did not say hello to the Router within {timeout:g}s")
if not outcome.get("ok"):
    give_up(f"The Codex bridge failed to start: {outcome.get('error')}")

target = os.path.normpath(key_file)
env_re = re.compile(r"""CCDM_ROUTER_KEY_FILE=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")

def find_pid():
    try:
        ps = subprocess.check_output(["ps", "axeww", "-o", "pid=,command="], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return None
    for line in ps.splitlines():
        pid_text, _, command = line.strip().partition(" ")
        if not pid_text.isdigit() or "ps axeww" in command or "python3 -" in command:
            continue
        try:
            argv = shlex.split(command)
        except ValueError:
            continue
        if len(argv) < 2 or os.path.basename(argv[0]) != "node" or not argv[1].endswith("codex-bridge.js"):
            continue
        keys = [next(g for g in m.groups() if g is not None) for m in env_re.finditer(command)]
        if any(os.path.normpath(key) == target for key in keys):
            return int(pid_text)
    return None

pid = None
for _ in range(20):
    pid = find_pid()
    if pid:
        break
    time.sleep(0.5)
if not pid:
    give_up("The thread session's Codex bridge process could not be found")
print(json.dumps({"pid": pid, "provider_conversation_id": outcome.get("provider_conversation_id"), "tmux": screen,
                  "provider_home": codex_home, "ws_port": int(ws_port)}))
PY
)" || fail "$(cat "$LAUNCH_DIR/.failure" 2>/dev/null || echo "The thread session did not start")"
  echo "Attach with: tmux attach -t $TMUX_NAME" >&2
  echo "$RESULT"
  exit 0
fi

MODEL_FLAG=""
[[ -n "$MODEL" ]] && MODEL_FLAG=" --model '$MODEL'"
EFFORT_FLAG=""
[[ -n "$EFFORT" ]] && EFFORT_FLAG=" --effort '$EFFORT'"
RESUME_FLAG=""
[[ -n "$RESUME_ID" ]] && RESUME_FLAG=" --resume '$RESUME_ID'"
if ! tmux new-session -d -s "$TMUX_NAME" -- zsh -ic "cd '$PATH_DIR' && CCDM_ROUTER_KEY_FILE='$KEY_FILE'$CONFIG_DIR_ENV claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions --mcp-config '$LAUNCH_DIR/mcp.json' --settings '$LAUNCH_DIR/settings.json'$MODEL_FLAG$EFFORT_FLAG$RESUME_FLAG" >&2; then
  fail "tmux could not start the thread session"
fi
echo "Started Claude thread session in tmux session '$TMUX_NAME'" >&2

# Accept the per-launch development-channel confirmation, then wait for the
# channel server's Router hello; the boot timeout covers both.
python3 - "$TMUX_NAME" "$LAUNCH_DIR/ready.json" <<'PY' >&2 || fail "$(cat "$LAUNCH_DIR/.failure" 2>/dev/null || echo "The thread session did not start")"
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

screen, ready_file = sys.argv[1:3]
failure = Path(ready_file).with_name(".failure")
timeout = float(os.environ.get("CCDM_THREAD_BOOT_TIMEOUT_S") or 120)
deadline = time.monotonic() + timeout
prompt = re.compile(r"development channels?", re.IGNORECASE)

def give_up(reason: str) -> None:
    failure.write_text(reason)
    sys.exit(reason)

accepted = False
while time.monotonic() < deadline:
    pane = subprocess.run(["tmux", "capture-pane", "-t", f"={screen}:", "-p"], capture_output=True, text=True)
    if pane.returncode != 0:
        give_up("Claude exited before the development-channel confirmation")
    if prompt.search(pane.stdout):
        subprocess.run(["tmux", "send-keys", "-t", f"={screen}:", "Enter"], check=True)
        accepted = True
        break
    time.sleep(0.2)
if not accepted:
    give_up(f"The development-channel confirmation never appeared within {timeout:g}s")

while time.monotonic() < deadline:
    if subprocess.run(["tmux", "has-session", "-t", f"={screen}"], capture_output=True).returncode != 0:
        give_up("Claude exited before its Router hello")
    try:
        with open(ready_file) as f:
            outcome = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        time.sleep(0.2)
        continue
    if outcome.get("ok"):
        sys.exit(0)
    give_up(f"The channel server's Router hello failed: {outcome.get('error')}")
give_up(f"The channel server did not say hello to the Router within {timeout:g}s")
PY

# The Claude listener's PID, and its session id from <claude_home>/sessions/<pid>.json.
RESULT="$(python3 - "$KEY_FILE" "$CLAUDE_HOME" "$TMUX_NAME" <<'PY'
import json
import os
import re
import shlex
import subprocess
import sys
import time

key_file, claude_home, tmux_name = sys.argv[1:4]
target = os.path.normpath(key_file)
env_re = re.compile(r"""CCDM_ROUTER_KEY_FILE=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")

def find_pid():
    try:
        ps = subprocess.check_output(["ps", "axeww", "-o", "pid=,command="], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return None
    for line in ps.splitlines():
        pid_text, _, command = line.strip().partition(" ")
        if not pid_text.isdigit() or "ps axeww" in command or "python3 -" in command:
            continue
        try:
            argv = shlex.split(command)
        except ValueError:
            continue
        if not argv or os.path.basename(argv[0]) != "claude" or "server:ccdm" not in argv:
            continue
        keys = [next(g for g in m.groups() if g is not None) for m in env_re.finditer(command)]
        if any(os.path.normpath(key) == target for key in keys):
            return int(pid_text)
    return None

pid = None
for _ in range(20):
    pid = find_pid()
    if pid:
        break
    time.sleep(0.5)
if not pid:
    sys.exit("The thread session's Claude process could not be found")
session_id = None
session_file = os.path.join(claude_home, "sessions", f"{pid}.json")
for _ in range(20):
    try:
        with open(session_file) as f:
            session = json.load(f)
        session_id = session.get("sessionId") or session.get("session_id") or session.get("id")
        break
    except Exception:
        time.sleep(0.5)
print(json.dumps({"pid": pid, "provider_conversation_id": session_id, "tmux": tmux_name,
                  "provider_home": claude_home}))
PY
)" || fail "The thread session's Claude process could not be found"

echo "Attach with: tmux attach -t $TMUX_NAME" >&2
echo "$RESULT"
