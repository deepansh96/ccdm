#!/bin/zsh
# Usage: ./scripts/start-thread-session.sh <project_name> <thread_id> [resume_session_id]
#          [--account <claude_accounts alias>] [--model <model>] [--effort <effort>]
# Starts a Claude Thread Conversation pinned to one Discord thread under the
# project's channel, in tmux session <screen_name>-t-<last 6 digits of the
# thread id>. The Thread Supervisor runs this and then drives startup and the
# bootstrap handoff. With a session id it resumes that Claude conversation
# (`claude --resume`) under the same Claude home and cwd. The options are the
# thread's own account, model, and effort overrides. It never touches the
# project's Channel Conversation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$ROOT_DIR/registry.json"

PROJECT="${1:-}"
THREAD_ID="${2:-}"
RESUME_ID=""
OVERRIDE_ARGS=()
if [[ -z "$PROJECT" || -z "$THREAD_ID" ]]; then
  echo "Usage: $0 <project_name> <thread_id> [resume_session_id] [--account <alias>] [--model <model>] [--effort <effort>]"
  exit 1
fi
shift 2
if [[ $# -gt 0 && "$1" != --* ]]; then
  RESUME_ID="$1"
  shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --account|--model|--effort)
      [[ $# -ge 2 ]] || { echo "$1 needs a value" >&2; exit 1; }
      OVERRIDE_ARGS+=("$1" "$2")
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# The thread state dir is <bot state_dir>/threads/<thread_id>, so every
# listener lookup below matches only this thread's exact state-dir path.
THREAD_FIELDS="$(python3 "$SCRIPT_DIR/claude-launch.py" resolve "$REGISTRY" "$PROJECT" --thread-id "$THREAD_ID" "${OVERRIDE_ARGS[@]}")" || exit $?
IFS=$'\t' read -r PATH_DIR STATE_DIR SESSION_NAME _MODEL _EFFORT _CLAUDE_HOME _CHANNEL_ID <<< "$THREAD_FIELDS"

if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
  echo "Session '$SESSION_NAME' is already running."
  exit 0
fi

EXISTING_PIDS="$(python3 "$SCRIPT_DIR/claude-launch.py" listener-pids "$STATE_DIR")"
if [[ -n "$EXISTING_PIDS" ]]; then
  echo "Refusing to start thread $THREAD_ID of '$PROJECT': existing Claude Discord listener process(es) already use $STATE_DIR:" >&2
  echo "$EXISTING_PIDS" | sed 's/^/  /' >&2
  exit 1
fi

# The helper prepares the private thread state dir (symlinked .env, parent-only
# access.json), writes this thread's own proxy MCP config and settings, and
# maps model, effort, and account exactly as for the Channel Conversation.
RESUME_ARGS=()
[[ -n "$RESUME_ID" ]] && RESUME_ARGS=(--resume "$RESUME_ID")
LAUNCH_COMMAND="$(python3 "$SCRIPT_DIR/claude-launch.py" launch-command "$REGISTRY" "$PROJECT" --thread-id "$THREAD_ID" "${RESUME_ARGS[@]}" "${OVERRIDE_ARGS[@]}")" || exit $?
tmux new-session -d -s "$SESSION_NAME" -- zsh -ic "$LAUNCH_COMMAND"
echo "Started Claude thread session in tmux session '$SESSION_NAME'"
