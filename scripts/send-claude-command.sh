#!/bin/sh
# Usage: ./scripts/send-claude-command.sh <project|channel_id|thread_id|link> <compact|clear|/compact|/clear>
#        ./scripts/send-claude-command.sh --project <project> <compact|clear|/compact|/clear>
#        ./scripts/send-claude-command.sh --channel <channel_id|thread_id|link> <compact|clear|/compact|/clear>
# The command itself is scripts/ccdmlib/cli/send_claude_command.py.
exec "$(cd "$(dirname "$0")" && pwd)/ccdm" send-claude-command "$@"
