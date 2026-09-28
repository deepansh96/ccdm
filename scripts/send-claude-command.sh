#!/bin/zsh
# Usage:
#   scripts/send-claude-command.sh <project|channel_id> <compact|clear|/compact|/clear>
#   scripts/send-claude-command.sh --project <project> <compact|clear|/compact|/clear>
#   scripts/send-claude-command.sh --channel <channel_id> <compact|clear|/compact|/clear>
#
# Sends a Claude Code slash command into a registered local Claude tmux session.
# This is intended for root-agent relay commands from Discord project channels.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

usage() {
  cat <<'EOF'
Usage:
  scripts/send-claude-command.sh <project|channel_id> <compact|clear|/compact|/clear>
  scripts/send-claude-command.sh --project <project> <compact|clear|/compact|/clear>
  scripts/send-claude-command.sh --channel <channel_id> <compact|clear|/compact|/clear>
EOF
}

MODE="auto"
TARGET=""
REQUESTED_COMMAND=""

case "${1:-}" in
  --project|-p)
    MODE="project"
    TARGET="${2:-}"
    REQUESTED_COMMAND="${3:-}"
    ;;
  --channel|-c)
    MODE="channel"
    TARGET="${2:-}"
    REQUESTED_COMMAND="${3:-}"
    ;;
  --help|-h|"")
    usage
    exit 0
    ;;
  *)
    TARGET="${1:-}"
    REQUESTED_COMMAND="${2:-}"
    ;;
esac

if [[ -z "$TARGET" || -z "$REQUESTED_COMMAND" ]]; then
  usage >&2
  exit 2
fi

case "$REQUESTED_COMMAND" in
  compact|/compact)
    CLAUDE_COMMAND="/compact"
    ;;
  clear|/clear)
    CLAUDE_COMMAND="/clear"
    ;;
  *)
    echo "Unsupported command '$REQUESTED_COMMAND'. Allowed commands: /compact, /clear." >&2
    exit 2
    ;;
esac

RESOLVED="$(python3 - "$REGISTRY" "$MODE" "$TARGET" "$SCRIPT_DIR/resolve-conversation.py" <<'PY'
import json
import os
import subprocess
import sys

registry_path, mode, target, resolver = sys.argv[1:5]

try:
    with open(registry_path) as f:
        registry = json.load(f)
except FileNotFoundError:
    print(f"registry.json not found at {registry_path}", file=sys.stderr)
    sys.exit(2)
except json.JSONDecodeError as exc:
    print(f"registry.json is invalid JSON: {exc}", file=sys.stderr)
    sys.exit(2)

projects = registry.get("projects", {})

project_name = None
project = None
thread_id = None
provider = None

if mode in ("auto", "project") and target in projects:
    project_name = target
    project = projects[target]

if project is None and mode == "project":
    print(f"Unknown project: {target}", file=sys.stderr)
    sys.exit(2)

if project is None:
    # A project channel or one of its bound threads, through the shared conversation resolver.
    found = subprocess.run([sys.executable, resolver, target, "--project-root", os.path.dirname(registry_path)],
                           capture_output=True, text=True)
    if found.returncode != 0:
        print(found.stderr.strip(), file=sys.stderr)
        sys.exit(2)
    conversation = json.loads(found.stdout)
    project_name, thread_id, provider = conversation["project"], conversation["thread_id"], conversation["provider"]
    project = projects[project_name]

screen_name = project.get("screen_name")
if not screen_name:
    print(f"Project {project_name} has no screen_name in registry.json", file=sys.stderr)
    sys.exit(2)

print("\t".join([
    project_name,
    # A Claude thread runs in tmux `<screen_name>-t-<last 6 digits of the thread id>`.
    f"{screen_name}-t-{thread_id[-6:]}" if thread_id else screen_name,
    provider or project.get("type", "claude"),
    os.path.expanduser(project.get("path", "")),
    thread_id or str(project.get("channel_id", "")),
]))
PY
)"

IFS=$'\t' read -r PROJECT_NAME SCREEN_NAME SESSION_TYPE PATH_DIR CHANNEL_ID <<< "$RESOLVED"

if [[ "$SESSION_TYPE" != "claude" ]]; then
  echo "Project '$PROJECT_NAME' is type '$SESSION_TYPE', not 'claude'. Codex sessions handle /compact and /clear directly in their project channel." >&2
  exit 1
fi

if [[ "$PATH_DIR" == remote:* ]]; then
  echo "Project '$PROJECT_NAME' is remote ($PATH_DIR). Run $CLAUDE_COMMAND on the remote tmux session instead." >&2
  exit 1
fi

if ! tmux has-session -t "=$SCREEN_NAME" 2>/dev/null; then
  echo "Claude tmux session '$SCREEN_NAME' for project '$PROJECT_NAME' is not running." >&2
  exit 1
fi

tmux send-keys -t "$SCREEN_NAME" -l "$CLAUDE_COMMAND"
tmux send-keys -t "$SCREEN_NAME" Enter

echo "Sent $CLAUDE_COMMAND to Claude project '$PROJECT_NAME' (tmux session '$SCREEN_NAME', channel '$CHANNEL_ID')."
