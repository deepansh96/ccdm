#!/bin/sh
# Usage: ./scripts/start-codex-session.sh <project_name> [--resume <thread_uuid>]
# The command itself is scripts/ccdmlib/cli/start_codex_session.py.
CCDM_INVOKED_AS=$0
export CCDM_INVOKED_AS
exec "$(cd "$(dirname "$0")" && pwd)/ccdm" start-codex-session "$@"
