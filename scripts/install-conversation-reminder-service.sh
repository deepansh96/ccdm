#!/bin/sh
set -eu

# Opt-in macOS LaunchAgent supervisor for the Conversation Reminder worker.
# It supervises the same `conversation-reminder-service.py run` worker used in
# the foreground, so the single-worker lock and reconciliation rules are shared.

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
TEMPLATE_PATH=$SCRIPT_DIR/com.discord.conversation-reminders.plist.in
SERVICE_PATH=$SCRIPT_DIR/conversation-reminder-service.py
LABEL=com.discord.conversation-reminders
MINIMUM_NODE_MAJOR=22

usage() {
  echo "Usage: $0"
  echo "Validates reminder configuration, then installs and loads the $LABEL LaunchAgent."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

PYTHON_PATH=$(command -v python3 || true)
if [ -z "$PYTHON_PATH" ]; then
  echo "Error: python3 is required to install the Conversation Reminder LaunchAgent" >&2
  exit 1
fi
NODE_BIN=${CCDM_REMINDER_NODE:-$(command -v node || true)}
case "$NODE_BIN" in
  /*) ;;
  *)
    echo "Error: node $MINIMUM_NODE_MAJOR or newer is required; set CCDM_REMINDER_NODE to its absolute path" >&2
    exit 1
    ;;
esac
if [ ! -x "$NODE_BIN" ] || ! "$NODE_BIN" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $MINIMUM_NODE_MAJOR ? 0 : 1)" >/dev/null 2>&1; then
  echo "Error: node $MINIMUM_NODE_MAJOR or newer is required at $NODE_BIN" >&2
  exit 1
fi
for required in "$TEMPLATE_PATH" "$SERVICE_PATH"; do
  if [ ! -f "$required" ]; then
    echo "Error: required reminder service file not found: $required" >&2
    exit 1
  fi
done

STATE_DIR=${CCDM_REMINDER_STATE_DIR:-$HOME/.local/state/ccdm/conversation-reminders}
ROOT_STATE_DIR=${ROOT_DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}
for configured in "$STATE_DIR" "$ROOT_STATE_DIR"; do
  case "$configured" in
    /*) ;;
    *)
      echo "Error: CCDM_REMINDER_STATE_DIR and ROOT_DISCORD_STATE_DIR must be absolute paths" >&2
      exit 2
      ;;
  esac
done

# Read-only validation: nothing is created, re-permissioned, or reloaded when
# configuration, provider adapters, root credentials, or the store are unusable.
if ! preflight_output=$(ROOT_DISCORD_STATE_DIR=$ROOT_STATE_DIR "$PYTHON_PATH" "$SERVICE_PATH" preflight \
  --project-root "$PROJECT_ROOT" --state-dir "$STATE_DIR" 2>&1); then
  echo "Error: Conversation Reminder preflight failed; the existing LaunchAgent was left unchanged" >&2
  printf '%s\n' "$preflight_output" | "$PYTHON_PATH" -c '
import json
import sys

text = sys.stdin.read()
try:
    blockers = json.loads(text).get("blockers") or [json.loads(text).get("reason") or "unknown failure"]
except (ValueError, AttributeError):
    blockers = ["the reminder service could not run its preflight"]
for blocker in blockers:
    print(f"  - {blocker}", file=sys.stderr)
'
  exit 2
fi

PLIST_DIR=$HOME/Library/LaunchAgents
PLIST_PATH=$PLIST_DIR/$LABEL.plist
CANDIDATE_PATH=$PLIST_DIR/.$LABEL.$$.candidate
BACKUP_PATH=$PLIST_DIR/.$LABEL.$$.backup
STDOUT_PATH=$STATE_DIR/service.log
STDERR_PATH=$STATE_DIR/service.err
NODE_BIN_DIR=$(dirname -- "$NODE_BIN")

mkdir -p "$PLIST_DIR"

"$PYTHON_PATH" - "$TEMPLATE_PATH" "$CANDIDATE_PATH" "$PYTHON_PATH" "$SERVICE_PATH" "$PROJECT_ROOT" "$STATE_DIR" \
  "$NODE_BIN" "$NODE_BIN_DIR" "$ROOT_STATE_DIR" "$STDOUT_PATH" "$STDERR_PATH" "$LABEL" <<'PY'
import html
import os
import plistlib
import sys
from pathlib import Path


(
    template_name,
    destination_name,
    python_path,
    service_path,
    project_root,
    state_dir,
    node_path,
    node_bin_dir,
    root_state_dir,
    stdout_path,
    stderr_path,
    label,
) = sys.argv[1:]
template_path = Path(template_name)
candidate_path = Path(destination_name)
temporary_path = candidate_path.with_name(f".{candidate_path.name}.{os.getpid()}.tmp")
values = {
    "__PYTHON_PATH__": python_path,
    "__SERVICE_PATH__": service_path,
    "__PROJECT_ROOT__": project_root,
    "__STATE_DIR__": state_dir,
    "__NODE_PATH__": node_path,
    "__NODE_BIN_DIR__": node_bin_dir,
    "__ROOT_STATE_DIR__": root_state_dir,
    "__STDOUT_PATH__": stdout_path,
    "__STDERR_PATH__": stderr_path,
}
# Only non-secret paths may be rendered; credentials stay in their private files.
allowed_environment = {"CCDM_REMINDER_NODE", "CCDM_REMINDER_PYTHON", "PATH", "ROOT_DISCORD_STATE_DIR"}


def invalid(message):
    try:
        temporary_path.unlink()
    except FileNotFoundError:
        pass
    print(f"Error: rendered LaunchAgent plist is invalid: {message}", file=sys.stderr)
    raise SystemExit(1)


try:
    rendered = template_path.read_text(encoding="utf-8")
    for marker, value in values.items():
        rendered = rendered.replace(marker, html.escape(value, quote=True))
    if any(marker in rendered for marker in values):
        invalid("the template contains an unresolved placeholder")

    parsed = plistlib.loads(rendered.encode("utf-8"))
    if parsed.get("Label") != label:
        invalid("Label does not match the configured agent label")
    if parsed.get("ProgramArguments") != [python_path, service_path, "run", "--project-root", project_root,
                                         "--state-dir", state_dir]:
        invalid("ProgramArguments must run the resolved foreground worker")
    if parsed.get("RunAtLoad") is not True or parsed.get("KeepAlive") != {"SuccessfulExit": False}:
        invalid("the worker must start at load and relaunch only after an unsuccessful exit")
    environment = parsed.get("EnvironmentVariables")
    if not isinstance(environment, dict) or set(environment) != allowed_environment:
        invalid("EnvironmentVariables must contain only interpreter paths, PATH, and the root state directory")
    if environment["CCDM_REMINDER_NODE"] != node_path or environment["CCDM_REMINDER_PYTHON"] != python_path:
        invalid("the resolved node and python paths are missing")
    for key in ("StandardOutPath", "StandardErrorPath", "WorkingDirectory"):
        if not isinstance(parsed.get(key), str) or not os.path.isabs(parsed[key]):
            invalid(f"{key} must be an absolute path")
    if not all(os.path.isabs(value) for value in values.values() if value != node_bin_dir):
        invalid("all executable, state, and log paths must be absolute")

    candidate_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path.write_text(rendered, encoding="utf-8")
    plistlib.loads(temporary_path.read_bytes())
    os.replace(temporary_path, candidate_path)
except SystemExit:
    raise
except (OSError, UnicodeError, ValueError, plistlib.InvalidFileException) as error:
    invalid(str(error) or "unable to parse the rendered XML")
PY

# The worker's state and logs are private; launchd appends to the prepared logs.
if ! "$PYTHON_PATH" - "$STATE_DIR" "$STDOUT_PATH" "$STDERR_PATH" <<'PY'
import os
import sys
from pathlib import Path

state_dir = Path(sys.argv[1])
state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(state_dir, 0o700)
for name in sys.argv[2:]:
    os.close(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))
    os.chmod(name, 0o600)
PY
then
  echo "Error: unable to prepare the private reminder state directory" >&2
  "$PYTHON_PATH" -c 'import pathlib, sys; pathlib.Path(sys.argv[1]).unlink(missing_ok=True)' "$CANDIDATE_PATH"
  exit 1
fi

prior_job_loaded=0
if launchctl list "$LABEL" >/dev/null 2>&1; then
  prior_job_loaded=1
fi

if ! launchctl unload "$PLIST_PATH" >/dev/null 2>&1; then
  if [ "$prior_job_loaded" -eq 1 ]; then
    echo "Error: unable to unload LaunchAgent '$LABEL'" >&2
    "$PYTHON_PATH" -c 'import pathlib, sys; pathlib.Path(sys.argv[1]).unlink(missing_ok=True)' "$CANDIDATE_PATH"
    exit 1
  fi
fi

prior_plist_exists=0
if [ -f "$PLIST_PATH" ]; then
  prior_plist_exists=1
fi

if ! "$PYTHON_PATH" - "$PLIST_PATH" "$CANDIDATE_PATH" "$BACKUP_PATH" "$prior_plist_exists" <<'PY'
import os
from pathlib import Path
import shutil
import sys

destination_path = Path(sys.argv[1])
candidate_path = Path(sys.argv[2])
backup_path = Path(sys.argv[3])
prior_plist_exists = sys.argv[4] == "1"

try:
    if prior_plist_exists:
        shutil.copy2(destination_path, backup_path)
    os.replace(candidate_path, destination_path)
except Exception:
    backup_path.unlink(missing_ok=True)
    candidate_path.unlink(missing_ok=True)
    raise
PY
then
  echo "Error: unable to install rendered LaunchAgent '$LABEL'" >&2
  if [ "$prior_job_loaded" -eq 1 ] && ! launchctl load "$PLIST_PATH" >/dev/null 2>&1; then
    echo "Error: failed to restore the previous LaunchAgent" >&2
  fi
  exit 1
fi

rollback() {
  rollback_status=0
  if ! launchctl unload "$PLIST_PATH" >/dev/null 2>&1; then
    :
  fi
  if ! "$PYTHON_PATH" - "$PLIST_PATH" "$BACKUP_PATH" "$CANDIDATE_PATH" "$prior_plist_exists" <<'PY'
from pathlib import Path
import os
import sys

destination_path = Path(sys.argv[1])
backup_path = Path(sys.argv[2])
candidate_path = Path(sys.argv[3])
prior_plist_exists = sys.argv[4] == "1"

if prior_plist_exists:
    os.replace(backup_path, destination_path)
else:
    destination_path.unlink(missing_ok=True)
candidate_path.unlink(missing_ok=True)
PY
  then
    rollback_status=1
  fi
  if [ "$prior_job_loaded" -eq 1 ]; then
    if ! launchctl load "$PLIST_PATH" >/dev/null 2>&1; then
      rollback_status=1
    fi
  fi
  if [ "$rollback_status" -ne 0 ]; then
    echo "Error: unable to load LaunchAgent '$LABEL'; failed to restore the previous LaunchAgent" >&2
  else
    echo "Error: unable to load LaunchAgent '$LABEL'; restored the previous LaunchAgent" >&2
  fi
  return "$rollback_status"
}

if ! launchctl load "$PLIST_PATH" >/dev/null 2>&1; then
  rollback || true
  exit 1
fi

"$PYTHON_PATH" -c 'import pathlib, sys; pathlib.Path(sys.argv[1]).unlink(missing_ok=True)' "$BACKUP_PATH"

launch_state=loaded
if launch_state_output=$(launchctl list "$LABEL" 2>/dev/null); then
  launch_state=$(echo "$launch_state_output" | tr '\n' ' ' | sed 's/[[:space:]]*$//')
fi
echo "LaunchAgent '$LABEL' loaded"
echo "LaunchAgent state: ${launch_state:-loaded}"
echo "Reminder state directory: $STATE_DIR"
echo "Standard output log: $STDOUT_PATH"
echo "Standard error log: $STDERR_PATH"
printf '%s\n' "$preflight_output" | "$PYTHON_PATH" -c '
import json
import sys

current = json.loads(sys.stdin.read())
if current.get("disabled"):
    print("Reminders are disabled: the supervised worker exits at launch until you run "
          "scripts/conversation-reminder-service.py enable and rerun this installer.")
elif not current.get("discovery_requested"):
    print("Delivery stays off until scripts/conversation-reminder-service.py enable; "
          "the worker observes but sends nothing.")
else:
    print("Reminders are enabled; run scripts/conversation-reminder-service.py status for per-channel readiness.")
'
