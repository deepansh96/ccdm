#!/bin/zsh
# Usage:
#   scripts/send-claude-command.sh <project|channel_id|thread_id|link> <compact|clear|/compact|/clear>
#   scripts/send-claude-command.sh --project <project> <compact|clear|/compact|/clear>
#   scripts/send-claude-command.sh --channel <channel_id|thread_id|link> <compact|clear|/compact|/clear>
#
# Sends a Claude Code slash command into a registered local Claude tmux session.
# This is intended for root-agent relay commands from Discord project channels.
# A target that is no project name or registered channel id goes through
# scripts/conversation-resolver.js; a thread's command goes to the thread's
# own tmux session, `<screen>-t-<thread id>`. Exits 2 with the
# resolver's reason when it cannot name the target.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

usage() {
  cat <<'EOF'
Usage:
  scripts/send-claude-command.sh <project|channel_id|thread_id|link> <compact|clear|/compact|/clear>
  scripts/send-claude-command.sh --project <project> <compact|clear|/compact|/clear>
  scripts/send-claude-command.sh --channel <channel_id|thread_id|link> <compact|clear|/compact|/clear>
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

# Prints the target's project, tmux session, type, path, channel and thread
# (empty for a project channel). Mode `conversation` takes the resolver's JSON;
# exit 3 means the target needs the resolver.
lookup() {
  python3 - "$REGISTRY" "$@" <<'PY'
import json
import os
import sys

registry_path, mode, target = sys.argv[1:4]

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
thread_id = ""

if mode == "conversation":
    conversation = json.loads(target)
    project_name = conversation["project"]
    project = projects.get(project_name)
    thread_id = conversation.get("thread_id") or ""
    if project is None:
        print(f"Unknown project: {project_name}", file=sys.stderr)
        sys.exit(2)
    if thread_id:
        project = {**project, "type": conversation.get("provider") or project.get("type", "claude")}

if mode in ("auto", "project") and target in projects:
    project_name = target
    project = projects[target]

if project is None and mode in ("auto", "channel"):
    matches = [(name, cfg) for name, cfg in projects.items() if str(cfg.get("channel_id", "")) == target]
    if len(matches) == 1:
        project_name, project = matches[0]
    elif len(matches) > 1:
        names = ", ".join(name for name, _ in matches)
        print(f"Channel {target} matches multiple projects: {names}", file=sys.stderr)
        sys.exit(2)

if project is None:
    if mode == "project":
        print(f"Unknown project: {target}", file=sys.stderr)
        sys.exit(2)
    sys.exit(3)

screen_name = project.get("screen_name")
if not screen_name:
    print(f"Project {project_name} has no screen_name in registry.json", file=sys.stderr)
    sys.exit(2)

print("\t".join([
    project_name,
    f"{screen_name}-t-{thread_id}" if thread_id else screen_name,
    project.get("type", "claude"),
    os.path.expanduser(project.get("path", "")),
    str(project.get("channel_id", "")),
    thread_id,
]))
PY
}

STATUS=0
RESOLVED="$(lookup "$MODE" "$TARGET")" || STATUS=$?
if (( STATUS == 3 )); then
  CONVERSATION="$(CCDM_REGISTRY_PATH="$REGISTRY" "${CCDM_ROUTER_NODE:-node}" "$SCRIPT_DIR/conversation-resolver.js" "$TARGET")" || exit 2
  STATUS=0
  RESOLVED="$(lookup conversation "$CONVERSATION")" || STATUS=$?
fi
(( STATUS == 0 )) || exit "$STATUS"

IFS=$'\t' read -r PROJECT_NAME SCREEN_NAME SESSION_TYPE PATH_DIR CHANNEL_ID THREAD_ID <<< "$RESOLVED"
if [[ -n "$THREAD_ID" ]]; then
  SUBJECT="thread $THREAD_ID in project '$PROJECT_NAME'"
  SUBJECT_START="Thread $THREAD_ID in project '$PROJECT_NAME'"
  OWN_CHANNEL="thread"
else
  SUBJECT="project '$PROJECT_NAME'"
  SUBJECT_START="Project '$PROJECT_NAME'"
  OWN_CHANNEL="project channel"
fi

if [[ "$SESSION_TYPE" != "claude" ]]; then
  echo "$SUBJECT_START is type '$SESSION_TYPE', not 'claude'. Codex sessions handle /compact and /clear directly in their $OWN_CHANNEL." >&2
  exit 1
fi

if [[ "$PATH_DIR" == remote:* ]]; then
  echo "$SUBJECT_START is remote ($PATH_DIR). Run $CLAUDE_COMMAND on the remote tmux session instead." >&2
  exit 1
fi

if ! tmux has-session -t "=$SCREEN_NAME" 2>/dev/null; then
  echo "Claude tmux session '$SCREEN_NAME' for $SUBJECT is not running." >&2
  exit 1
fi

tmux send-keys -t "$SCREEN_NAME" -l "$CLAUDE_COMMAND"
tmux send-keys -t "$SCREEN_NAME" Enter

if [[ -n "$THREAD_ID" ]]; then
  echo "Sent $CLAUDE_COMMAND to Claude $SUBJECT (tmux session '$SCREEN_NAME')."
else
  echo "Sent $CLAUDE_COMMAND to Claude $SUBJECT (tmux session '$SCREEN_NAME', channel '$CHANNEL_ID')."
fi
