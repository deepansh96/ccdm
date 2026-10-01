#!/bin/zsh
# Usage: ./scripts/threads.sh create <project> <name> [--provider claude|codex]
#          [--account <alias>] [--model <model>] [--effort <effort>] [message…]
# Creates a Thread Conversation through the running Thread Supervisor's
# private control socket, as `/thread` does in a project channel, with
# requester `root`. With a message the session starts at once, the message
# as its starter. Prints the created thread as JSON.
#        ./scripts/threads.sh list [<project>]
# Prints each bound thread's project, name, id, provider/model, state (with
# its stop or close reason) and idle time.
#        ./scripts/threads.sh stop|restart|close [<project>] <name|link|id>
# Finds the thread through scripts/conversation-resolver.js, then stops its
# session as `stopped/operator`, or runs its `/restart` or `/close` as the
# owner would in the thread.
# Exits 2 when nothing was done for bad usage, a bad flag or setting, or a
# thread the resolver cannot name, and 1 when no supervisor answers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 - "$SCRIPT_DIR" "$@" <<'PY'
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
from thread_supervisor.threads_cli import main
raise SystemExit(main(sys.argv[2:]))
PY
