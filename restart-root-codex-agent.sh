#!/bin/sh
# Restart the root agent as a Codex bridge in root mode: ./restart-root-codex-agent.sh [channel_id]
# The command is `ccdm restart-root --provider codex`, in scripts/ccdmlib/cli/restart_root.py.
exec "$(cd "$(dirname "$0")" && pwd)/scripts/ccdm" restart-root --provider codex "$@"
