#!/bin/sh
# Restart the root agent (Claude), from any terminal or from inside root itself.
# The command is `ccdm restart-root`, in scripts/ccdmlib/cli/restart_root.py.
exec "$(cd "$(dirname "$0")" && pwd)/scripts/ccdm" restart-root "$@"
