#!/bin/sh
# Usage: ./scripts/start-gemini-session.sh <project_name> [--resume <session_uuid>]
# The command itself is scripts/ccdmlib/cli/start_gemini_session.py.
CCDM_INVOKED_AS=$0
export CCDM_INVOKED_AS
exec "$(cd "$(dirname "$0")" && pwd)/ccdm" start-gemini-session "$@"
