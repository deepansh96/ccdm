#!/bin/sh
# Usage: ./scripts/start-session.sh <project_name> [--resume <session_id>]
# The command is `ccdm start-session`, in scripts/ccdmlib/cli/start_session.py.
CCDM_SHIM_ARGV0=$0
export CCDM_SHIM_ARGV0
exec "$(cd "$(dirname "$0")" && pwd)/ccdm" start-session "$@"
