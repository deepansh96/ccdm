#!/bin/sh
# Usage: ./scripts/stop-session.sh <project_name> [--threads|--all]
exec "$(cd "$(dirname "$0")" && pwd)/ccdm" stop-session "$@"
