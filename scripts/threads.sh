#!/bin/zsh
# Usage: ./scripts/threads.sh create <project> <name> [--provider claude|codex] [--account X] [--model Y]
#          [--effort Z] [first message…]
# Root's operator surface for Thread Conversations. It acts through the running
# Thread Supervisor's private request socket, with the same validation and
# creation path as `/thread`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUPERVISOR="$SCRIPT_DIR/thread-supervisor.py"

usage() {
  echo "Usage: $0 create <project> <name> [--provider claude|codex] [--account X] [--model Y] [--effort Z] [first message…]" >&2
  exit 1
}

# One request to the supervisor; print its JSON reply, or its one-line reason and fail.
submit() {
  local subcommand="$1" payload="$2" reply
  if reply=$("$SUPERVISOR" submit --payload "$payload"); then
    printf '%s\n' "$reply"
    return 0
  fi
  local reason
  reason=$(printf '%s' "$reply" | python3 -c 'import json, sys; print(json.load(sys.stdin)["reason"])' 2>/dev/null) ||
    reason="the thread supervisor refused the request"
  echo "threads.sh $subcommand: $reason" >&2
  exit 1
}

case "${1:-}" in
  create)
    shift
    [[ $# -ge 2 ]] || usage
    # The words after the project are `/thread` arguments.
    submit create "$(python3 -c 'import json, sys
print(json.dumps({"requester": "root", "project": sys.argv[1], "arguments": " ".join(sys.argv[2:])}))' "$@")"
    ;;
  *)
    usage
    ;;
esac
