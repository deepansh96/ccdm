#!/bin/sh
# Usage: ./scripts/start-thread-session.sh <project> <thread_id> --provider claude|codex
#          [--account <alias>] [--model <model>] [--effort <effort>] [--resume <id>] [--home <path>]
# The command itself is scripts/ccdmlib/cli/start_thread_session.py.
CCDM_INVOKED_AS=$0
export CCDM_INVOKED_AS
exec "$(cd "$(dirname "$0")" && pwd)/ccdm" start-thread-session "$@"
