#!/bin/zsh
# Usage: ./scripts/start-gemini-session.sh <project_name> [--resume <session_uuid>]
# Starts a Gemini project's Discord session: scripts/gemini-bridge.js in tmux,
# driving `agy acp` (the Google Antigravity CLI) in the project path. Like a
# Codex project it is served through the Router with a fresh launch key and no
# Discord token, and its PID is recorded only after the bridge's Router hello.
#
# The model and thinking level come from the project's `gemini_model` (or
# `model`) and `gemini_effort`; unset, the bridge uses gemini-4-neon at high.
# The project's `gemini_account`, an alias in `gemini_accounts`, names the
# home agy runs under (its sign-in); unset, agy runs under the user's home.
# --resume continues an agy conversation, which must exist in that home's
# .gemini/antigravity-cli/conversations; it never falls back to a fresh one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

usage() {
  echo "Usage: $0 <project_name> [--resume <session_uuid>]" >&2
  exit 1
}

PROJECT="${1:-}"
[[ -n "$PROJECT" ]] || usage
RESUME_SESSION_ID=""
if (( $# > 1 )); then
  [[ $# == 3 && "$2" == "--resume" ]] || usage
  RESUME_SESSION_ID="$3"
  if [[ ! "$RESUME_SESSION_ID" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]]; then
    echo "Resume session must be a canonical UUID" >&2
    exit 1
  fi
fi

ROUTER_STATE="${CCDM_ROUTER_STATE_DIR:-$HOME/.local/state/ccdm/router}"
KEY_FILE="$ROUTER_STATE/keys/$PROJECT.key"
LAUNCH_DIR="$ROUTER_STATE/launches/$PROJECT"
READY_FILE="$LAUNCH_DIR/ready.json"

# The bridge and its agy process carry this launch's key file path (never the
# key) in their environment; only that exact path matches, so other projects'
# and thread sessions never do.
find_gemini_listener_pids() {
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
    if exe == "agy":
        return "acp" in argv
    return exe == "node" and any(os.path.basename(arg) == "gemini-bridge.js" for arg in argv[1:])

for line in ps.splitlines():
    pid_text, _, command = line.strip().partition(" ")
    if not pid_text.isdigit() or "ps axeww" in command or "python3 -" in command:
        continue
    keys = [next(g for g in m.groups() if g is not None) for m in env_re.finditer(command)]
    if any(os.path.normpath(key) == target for key in keys) and is_listener(command):
        print(pid_text)
PY
}

LAUNCH_FIELDS="$(python3 - "$REGISTRY" "$PROJECT" <<'PY'
import json, os, re, sys
registry_path, project = sys.argv[1:3]
r = json.load(open(registry_path))
p = (r.get("projects") or {}).get(project)
if not isinstance(p, dict) or not project or "/" in project or project.startswith("."):
    sys.exit(f"Unknown project '{project}'")
# Both go into the tmux command line, so only plain values pass.
model = p.get("gemini_model") or p.get("model")
if model and not re.fullmatch(r"[A-Za-z0-9._:-]+", str(model)):
    sys.exit(f"Invalid gemini_model '{model}' for '{project}'")
effort = p.get("gemini_effort")
if effort and effort not in ("low", "medium", "high", "xhigh"):
    sys.exit(f"Invalid gemini_effort '{effort}' for '{project}' (expected low, medium, high, or xhigh)")
print("\t".join(str(value) if value not in (None, "") else "__NONE__" for value in [
    os.path.expanduser(p["path"]),
    p["screen_name"],
    p["channel_id"],
    p.get("type") or "claude",
    model,
    effort,
    p.get("webhook_id"),
    "0" if p.get("text_reply_fallback") is False else "",
]))
PY
)" || exit 1  # Python's reason is the last stderr line.
IFS=$'\t' read -r PATH_DIR SCREEN_NAME CHANNEL_ID PROJECT_TYPE GEMINI_MODEL_VALUE GEMINI_EFFORT_VALUE WEBHOOK_ID TEXT_REPLY_FALLBACK_VALUE <<< "$LAUNCH_FIELDS"

if [[ "$PROJECT_TYPE" != "gemini" ]]; then
  echo "Refusing to start '$PROJECT': it is a $PROJECT_TYPE project, not a gemini one." >&2
  exit 1
fi

# An unknown alias or missing home fails the start; the reason is the last stderr line.
AGY_HOME="$(python3 "$SCRIPT_DIR/resolve-gemini-home.py" "$REGISTRY" "$PROJECT")" || exit 1
if [[ -n "$RESUME_SESSION_ID" && ! -f "$AGY_HOME/.gemini/antigravity-cli/conversations/$RESUME_SESSION_ID.db" ]]; then
  echo "The agy conversation $RESUME_SESSION_ID is missing from $AGY_HOME/.gemini/antigravity-cli/conversations" >&2
  exit 1
fi

if tmux has-session -t "=$SCREEN_NAME" 2>/dev/null; then
  # A requested resume did not happen, so it is not a success.
  if [[ -n "$RESUME_SESSION_ID" ]]; then
    echo "Refusing to resume '$PROJECT': session '$SCREEN_NAME' is already running. Stop it first with scripts/stop-session.sh '$PROJECT'." >&2
    exit 1
  fi
  echo "Session '$SCREEN_NAME' is already running."
  exit 0
fi

EXISTING_PIDS="$(find_gemini_listener_pids)"
if [[ -n "$EXISTING_PIDS" ]]; then
  echo "Refusing to start '$PROJECT': existing Gemini bridge process(es) already use $KEY_FILE:"
  echo "$EXISTING_PIDS" | sed 's/^/  /'
  echo "Run scripts/stop-session.sh '$PROJECT' first, then retry."
  exit 1
fi

# The Router posts replies only through the project's webhook.
if [[ "$WEBHOOK_ID" == "__NONE__" ]]; then
  echo "Refusing to start '$PROJECT': it has no webhook_id, so its replies could not be posted. Run node scripts/router.js ensure-webhook $PROJECT, then retry." >&2
  exit 1
fi

GEMINI_ENV=" CCDM_AGY_HOME='$AGY_HOME'"
[[ "$GEMINI_MODEL_VALUE" != "__NONE__" ]] && GEMINI_ENV+=" GEMINI_MODEL='$GEMINI_MODEL_VALUE'"
[[ "$GEMINI_EFFORT_VALUE" != "__NONE__" ]] && GEMINI_ENV+=" GEMINI_EFFORT='$GEMINI_EFFORT_VALUE'"
[[ "$TEXT_REPLY_FALLBACK_VALUE" == "0" ]] && GEMINI_ENV+=" GEMINI_TEXT_REPLY_FALLBACK='0'"
[[ -n "$RESUME_SESSION_ID" ]] && GEMINI_ENV+=" GEMINI_RESUME_SESSION_ID='$RESUME_SESSION_ID'"
[[ -n "${CCDM_AGY_BIN:-}" ]] && GEMINI_ENV+=" CCDM_AGY_BIN='$CCDM_AGY_BIN'"
TRANSCRIBE_AUDIO_FLAG="${CODEX_BRIDGE_TRANSCRIBE_AUDIO:-${USE_AUDIO_TRANSCRIPTION_IN_BRIDGE:-}}"
[[ -n "$TRANSCRIBE_AUDIO_FLAG" ]] && GEMINI_ENV+=" CODEX_BRIDGE_TRANSCRIBE_AUDIO='$TRANSCRIBE_AUDIO_FLAG'"

# A fresh launch key revokes whichever session still holds the old one.
python3 - "$PROJECT" "$ROUTER_STATE" "$LAUNCH_DIR" <<'PY'
import os
import secrets
import sys
from pathlib import Path

project, router_state, launch_dir = sys.argv[1:4]
keys_dir = Path(router_state) / "keys"
launch = Path(launch_dir)
for directory in (Path(router_state), keys_dir, launch.parent, launch):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
(launch / "ready.json").unlink(missing_ok=True)
(launch / "context.json").unlink(missing_ok=True)
key_file = keys_dir / f"{project}.key"
tmp = key_file.with_name(f".{key_file.name}.{os.getpid()}.tmp")
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(secrets.token_urlsafe(32) + "\n")
os.replace(tmp, key_file)
PY

# zsh -i loads ~/.zshrc, so prompts there (oh-my-zsh's update prompt) must be
# switched off or a headless launch blocks before it starts anything.
tmux new-session -d -s "$SCREEN_NAME" -- env DISABLE_AUTO_UPDATE=true DISABLE_UPDATE_PROMPT=true zsh -ic "cd '$ROOT_DIR' && CCDM_GEMINI_PROJECT='$PROJECT' CCDM_ROUTER_STATE_DIR='$ROUTER_STATE' CCDM_ROUTER_KEY_FILE='$KEY_FILE' CCDM_CHANNEL_READY_FILE='$READY_FILE' CHANNEL_ID='$CHANNEL_ID' PROJECT_DIR='$PATH_DIR'$GEMINI_ENV node scripts/gemini-bridge.js"
echo "Started Gemini Router bridge in tmux session '$SCREEN_NAME'"

# The bridge reports its Router hello outcome once agy's session is open.
if ! python3 - "$SCREEN_NAME" "$READY_FILE" <<'PY'
import json
import os
import subprocess
import sys
import time

screen, ready_file = sys.argv[1:3]
deadline = time.monotonic() + float(os.environ.get("CCDM_GEMINI_LAUNCH_TIMEOUT_S") or 120)
while time.monotonic() < deadline:
    try:
        with open(ready_file) as f:
            outcome = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        if subprocess.run(["tmux", "has-session", "-t", "=" + screen],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            sys.exit("Gemini Router launch failed: bridge exited before saying hello")
        time.sleep(0.2)
        continue
    if outcome.get("ok"):
        print(f"Bridge connected to the Router (scope {outcome['scope']['channel_id']}, agy session {outcome.get('provider_conversation_id')})")
        sys.exit(0)
    sys.exit(f"Gemini Router launch failed: {outcome.get('error')}")
sys.exit("Gemini Router launch failed: the bridge never said hello to the Router")
PY
then
  echo "Launch of '$PROJECT' failed; cleaning up" >&2
  tmux kill-session -t "=$SCREEN_NAME" 2>/dev/null || true
  LEFTOVER="$(find_gemini_listener_pids)"
  if [[ -n "$LEFTOVER" ]]; then
    kill -TERM ${(f)LEFTOVER} 2>/dev/null || true
  fi
  python3 - "$KEY_FILE" "$LAUNCH_DIR" "$REGISTRY" "$PROJECT" "$SCRIPT_DIR/registry-update.py" <<'PY'
import importlib.util
import shutil
import sys
from pathlib import Path

sys.dont_write_bytecode = True

key_file, launch_dir, registry_path, project, helper = sys.argv[1:6]
Path(key_file).unlink(missing_ok=True)
# Only the channel launch's files go: threads/ holds the project's running
# Thread Conversations' launch files.
launch = Path(launch_dir)
if launch.is_dir() and not launch.is_symlink():
    for entry in launch.iterdir():
        if entry.name == "threads":
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)
    try:
        launch.rmdir()
    except OSError:
        pass
spec = importlib.util.spec_from_file_location("ccdm_registry_update", helper)
registry_update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry_update)
registry_update.set_project_fields(registry_path, project, {"pid": None, "session_id": None})
PY
  exit 1
fi

echo "Attach with: tmux attach -t $SCREEN_NAME"

# The bridge's PID and agy session id, under the registry lock every writer shares.
python3 - "$REGISTRY" "$PROJECT" "$KEY_FILE" "$READY_FILE" "$SCRIPT_DIR/registry-update.py" <<'PY'
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import time

registry_path, project, key_file, ready_file, helper = sys.argv[1:6]
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
        if len(argv) < 2 or os.path.basename(argv[0]) != "node" or not argv[1].endswith("gemini-bridge.js"):
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
    print("Warning: started session, but could not find the Gemini bridge PID to record")
    sys.exit(0)
try:
    session_id = json.load(open(ready_file)).get("provider_conversation_id")
except Exception:
    session_id = None
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("ccdm_registry_update", helper)
registry_update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry_update)
registry_update.set_project_fields(registry_path, project, {"pid": pid, "session_id": session_id})
print(f"Recorded PID {pid}")
PY
