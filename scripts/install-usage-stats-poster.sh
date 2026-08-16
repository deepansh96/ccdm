#!/bin/sh
set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
TEMPLATE_PATH=$SCRIPT_DIR/com.discord.usage-stats-poster.plist.in
POSTER_PATH=$SCRIPT_DIR/usage-stats-poster.py
LABEL=com.discord.usage-stats-poster
INTERVAL=1800

usage() {
  echo "Usage: $0 [--interval seconds]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --interval)
      if [ "$#" -lt 2 ]; then
        echo "Error: --interval requires a positive number of seconds" >&2
        exit 2
      fi
      INTERVAL=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$INTERVAL" in
  ''|*[!0-9]*)
    echo "Error: --interval must be a positive number of seconds" >&2
    exit 2
    ;;
esac
if [ "$INTERVAL" -eq 0 ]; then
  echo "Error: --interval must be a positive number of seconds" >&2
  exit 2
fi

PYTHON_PATH=$(command -v python3 || true)
CODEX_PATH=$(command -v codex || true)
if [ -z "$PYTHON_PATH" ]; then
  echo "Error: python3 is required to install the Usage Stats Poster LaunchAgent" >&2
  exit 1
fi
if [ -z "$CODEX_PATH" ]; then
  echo "Error: codex is required to install the Usage Stats Poster LaunchAgent" >&2
  exit 1
fi
if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "Error: LaunchAgent plist template not found: $TEMPLATE_PATH" >&2
  exit 1
fi
if [ ! -f "$POSTER_PATH" ]; then
  echo "Error: Usage Stats Poster script not found: $POSTER_PATH" >&2
  exit 1
fi

LOG_ROOT=${CCDM_USAGE_STATS_LOG_DIR:-${TMPDIR:-/tmp}}
if [ ! -d "$LOG_ROOT" ]; then
  mkdir -p "$LOG_ROOT"
fi
LOG_ROOT=$(cd -- "$LOG_ROOT" && pwd -P)
PLIST_DIR=$HOME/Library/LaunchAgents
PLIST_PATH=$PLIST_DIR/$LABEL.plist
STDOUT_PATH=$LOG_ROOT/usage-stats-poster.log
STDERR_PATH=$LOG_ROOT/usage-stats-poster.err
CODEX_BIN_DIR=$(dirname -- "$CODEX_PATH")

mkdir -p "$PLIST_DIR"

"$PYTHON_PATH" - "$TEMPLATE_PATH" "$PLIST_PATH" "$PYTHON_PATH" "$CODEX_PATH" "$CODEX_BIN_DIR" "$POSTER_PATH" "$STDOUT_PATH" "$STDERR_PATH" "$INTERVAL" "$LABEL" <<'PY'
import html
import os
import plistlib
import sys
from pathlib import Path


(
    template_name,
    destination_name,
    python_path,
    codex_path,
    codex_bin_dir,
    poster_path,
    stdout_path,
    stderr_path,
    interval_text,
    label,
) = sys.argv[1:]
template_path = Path(template_name)
destination_path = Path(destination_name)
temporary_path = destination_path.with_name(f".{destination_path.name}.{os.getpid()}.tmp")
values = {
    "__PYTHON_PATH__": python_path,
    "__CODEX_PATH__": codex_path,
    "__CODEX_BIN_DIR__": codex_bin_dir,
    "__POSTER_PATH__": poster_path,
    "__STDOUT_PATH__": stdout_path,
    "__STDERR_PATH__": stderr_path,
    "__INTERVAL__": interval_text,
}


def invalid(message):
    try:
        temporary_path.unlink()
    except FileNotFoundError:
        pass
    print(f"Error: rendered LaunchAgent plist is invalid: {message}", file=sys.stderr)
    raise SystemExit(1)


try:
    rendered = template_path.read_text(encoding="utf-8")
    for marker, value in values.items():
        replacement = value if marker == "__INTERVAL__" else html.escape(value, quote=True)
        rendered = rendered.replace(marker, replacement)
    if any(marker in rendered for marker in values):
        invalid("the template contains an unresolved placeholder")

    parsed = plistlib.loads(rendered.encode("utf-8"))
    if parsed.get("Label") != label:
        invalid("Label does not match the configured agent label")
    if parsed.get("ProgramArguments") != [python_path, poster_path]:
        invalid("ProgramArguments must invoke the resolved Python and poster paths")
    if type(parsed.get("StartInterval")) is not int or parsed["StartInterval"] <= 0:
        invalid("StartInterval must be a positive integer")
    environment = parsed.get("EnvironmentVariables")
    if not isinstance(environment, dict) or environment.get("CCDM_CODEX_PATH") != codex_path:
        invalid("the resolved Codex path is missing")
    for key in ("StandardOutPath", "StandardErrorPath"):
        if not isinstance(parsed.get(key), str) or not os.path.isabs(parsed[key]):
            invalid(f"{key} must be an absolute path")
    if not all(os.path.isabs(value) for value in (python_path, codex_path, poster_path, stdout_path, stderr_path)):
        invalid("all executable and log paths must be absolute")

    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path.write_text(rendered, encoding="utf-8")
    plistlib.loads(temporary_path.read_bytes())
    os.replace(temporary_path, destination_path)
except SystemExit:
    raise
except (OSError, UnicodeError, ValueError, plistlib.InvalidFileException) as error:
    invalid(str(error) or "unable to parse the rendered XML")
PY

if ! launchctl unload "$PLIST_PATH" >/dev/null 2>&1; then
  :
fi
if ! launchctl load "$PLIST_PATH" >/dev/null 2>&1; then
  echo "Error: unable to load LaunchAgent '$LABEL'" >&2
  exit 1
fi

launch_state=loaded
if launch_state_output=$(launchctl list "$LABEL" 2>/dev/null); then
  launch_state=$(echo "$launch_state_output" | tr '\n' ' ' | sed 's/[[:space:]]*$//')
fi
echo "LaunchAgent '$LABEL' loaded"
echo "LaunchAgent state: ${launch_state:-loaded}"
echo "Standard output log: $STDOUT_PATH"
echo "Standard error log: $STDERR_PATH"
