#!/bin/zsh
# Usage: ./scripts/threads.sh list <project>
#        ./scripts/threads.sh create <project> <name> [--provider claude|codex] [--account X] [--model Y]
#          [--effort Z] [first message…]
#        ./scripts/threads.sh stop|restart|close [<project>] <thread name, link, or id>
# Root's operator surface for Thread Conversations. `list` reads the thread
# store; the others act through the running Thread Supervisor's private request
# socket, `create` with the same validation and creation path as `/thread`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUPERVISOR="$SCRIPT_DIR/thread-supervisor.py"

usage() {
  echo "Usage: $0 list <project>" >&2
  echo "       $0 create <project> <name> [--provider claude|codex] [--account X] [--model Y] [--effort Z] [first message…]" >&2
  echo "       $0 stop|restart|close [<project>] <thread name, link, or id>" >&2
  exit 1
}

# Print a failed supervisor reply's one-line reason and fail.
fail() {
  local subcommand="$1" reply="$2" reason
  reason=$(printf '%s' "$reply" | python3 -c 'import json, sys; print(json.load(sys.stdin)["reason"])' 2>/dev/null) ||
    reason="the thread supervisor refused the request"
  echo "threads.sh $subcommand: $reason" >&2
  exit 1
}

# One request to the supervisor; print its JSON reply, or its one-line reason and fail.
submit() {
  local subcommand="$1" payload="$2" reply
  if reply=$("$SUPERVISOR" submit --payload "$payload"); then
    printf '%s\n' "$reply"
    return 0
  fi
  fail "$subcommand" "$reply"
}

case "${1:-}" in
  list)
    [[ $# -eq 2 ]] || usage
    if reply=$("$SUPERVISOR" list --project "$2"); then
      printf '%s\n' "$reply"
    else
      fail list "$reply"
    fi
    ;;
  create)
    shift
    [[ $# -ge 2 ]] || usage
    # The words after the project are `/thread` arguments.
    submit create "$(python3 -c 'import json, sys
print(json.dumps({"requester": "root", "project": sys.argv[1], "arguments": " ".join(sys.argv[2:])}))' "$@")"
    ;;
  stop|restart|close)
    op="$1"
    shift
    [[ $# -eq 1 || $# -eq 2 ]] || usage
    # With a project, a thread name is looked up in that project only.
    submit "$op" "$(python3 -c 'import json, sys
op, *target = sys.argv[1:]
print(json.dumps({"requester": "root", "op": op, "project": target[0] if len(target) == 2 else None,
                  "thread": target[-1]}))' "$op" "$@")"
    ;;
  *)
    usage
    ;;
esac
