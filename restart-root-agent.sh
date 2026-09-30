#!/bin/zsh
# Restart the root agent Discord bot
# Run this from any terminal — it kills the current instance and starts a new one in tmux

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Root Claude is always a Router client: the CCDM channel server in the root
# role, holding root's Router key and no Discord token. Root admin scripts keep
# reading the root token from root's Discord state directory.
ROUTER_STATE_DIR="${CCDM_ROUTER_STATE_DIR:-$HOME/.local/state/ccdm/router}"
ROOT_KEY_FILE="$ROUTER_STATE_DIR/keys/.root.key"
ROOT_LAUNCH_DIR="$ROUTER_STATE_DIR/launches/.root"
ROOT_READY_FILE="$ROOT_LAUNCH_DIR/ready.json"
# A restart rotates root's key and stops the running root, and the new root
# can only say hello to a live Router. While the Router is down the running
# root (perhaps on its emergency direct gateway) is the only way to reach
# root, so leave it and its key alone. The check is read-only and bounded.
if ! python3 - "$SCRIPT_DIR/scripts/router.js" <<'PY'
import os
import subprocess
import sys

node = os.environ.get("CCDM_ROUTER_NODE") or "node"
try:
    status = subprocess.run([node, sys.argv[1], "status"], stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True, timeout=15)
except (OSError, subprocess.TimeoutExpired) as error:
    sys.exit(f"Router status check failed: {error}")
if status.returncode:
    sys.exit(status.stderr.strip() or "Router status check failed")
PY
then
    echo "The Router is not answering, so root was not restarted: the running root and its key are unchanged. Start the Router (scripts/install-router-service.sh, or node scripts/router.js serve) and retry." >&2
    exit 1
fi
python3 - "$SCRIPT_DIR" "$ROUTER_STATE_DIR" "$ROOT_LAUNCH_DIR" <<'PY'
import json
import os
import secrets
import sys
from pathlib import Path

root, router_state, launch_dir = map(Path, sys.argv[1:4])
keys_dir = router_state / "keys"
for directory in (router_state, keys_dir, launch_dir.parent, launch_dir):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
(launch_dir / "ready.json").unlink(missing_ok=True)

def write_private(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)

key_file = keys_dir / ".root.key"
write_private(launch_dir / "mcp.json", json.dumps({"mcpServers": {"ccdm": {
    "command": "node",
    "args": [str(root / "scripts" / "ccdm-channel-server.js")],
    "env": {
        "CCDM_ROUTER_ROLE": "root",
        "CCDM_ROUTER_STATE_DIR": str(router_state),
        "CCDM_ROUTER_KEY_FILE": str(key_file),
        "CCDM_CHANNEL_READY_FILE": str(launch_dir / "ready.json"),
    },
}}}, indent=2) + "\n")
# The official Discord plugin must not load beside the CCDM channel.
write_private(launch_dir / "settings.json",
              json.dumps({"enabledPlugins": {"discord@claude-plugins-official": False}}, indent=2) + "\n")
# Replacing the key revokes the root session still holding the old one.
write_private(key_file, secrets.token_urlsafe(32) + "\n")
PY
if [[ $? -ne 0 ]]; then
    echo "Root Claude Router launch preparation failed" >&2
    exit 1
fi
ROOT_STATE_ASSIGNMENT="CCDM_ROUTER_KEY_FILE='$ROOT_KEY_FILE'"
CHANNEL_ARGS="--dangerously-load-development-channels server:ccdm --mcp-config '$ROOT_LAUNCH_DIR/mcp.json' --settings '$ROOT_LAUNCH_DIR/settings.json'"

# Kill the claude process inside the root_agent tmux pane (if running)
if tmux has-session -t root_agent 2>/dev/null; then
    PANE_PID=$(tmux display-message -t root_agent -p '#{pane_pid}' 2>/dev/null)
    if [ -n "$PANE_PID" ]; then
        # Kill the process tree rooted at the pane's shell
        pkill -TERM -P "$PANE_PID" 2>/dev/null
        sleep 1
    fi
    tmux kill-session -t root_agent 2>/dev/null
    sleep 2
    # Retry if still alive
    if tmux has-session -t root_agent 2>/dev/null; then
        tmux kill-session -t root_agent 2>/dev/null
        sleep 1
    fi
fi

# Start fresh in a detached tmux session
tmux new-session -d -s root_agent -- zsh -ic "cd '$SCRIPT_DIR' && $ROOT_STATE_ASSIGNMENT claude $CHANNEL_ARGS --dangerously-skip-permissions"

if [ $? -ne 0 ]; then
    echo "Failed to create tmux session 'root_agent'" >&2
    exit 1
fi

# Accept the per-launch development-channel confirmation, then wait for the
# channel server's Router hello as root.
if ! python3 - "$ROOT_READY_FILE" <<'PY'
import json
import os
import re
import subprocess
import sys
import time

ready_file = sys.argv[1]
timeout = float(os.environ.get("CCDM_CLAUDE_LAUNCH_TIMEOUT_S") or 60)
deadline = time.monotonic() + timeout
prompt = re.compile(r"development channels?", re.IGNORECASE)

accepted = False
while time.monotonic() < deadline:
    pane = subprocess.run(["tmux", "capture-pane", "-t", "=root_agent", "-p"], capture_output=True, text=True)
    if pane.returncode != 0:
        sys.exit("Root Claude exited before the development-channel confirmation")
    if prompt.search(pane.stdout):
        subprocess.run(["tmux", "send-keys", "-t", "=root_agent", "Enter"], check=True)
        accepted = True
        break
    time.sleep(0.2)
if not accepted:
    sys.exit("The development-channel confirmation never appeared")

while time.monotonic() < deadline:
    try:
        with open(ready_file) as f:
            outcome = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        time.sleep(0.2)
        continue
    if outcome.get("ok"):
        print("Root channel server connected to the Router")
        sys.exit(0)
    sys.exit(f"Root channel server's Router hello failed: {outcome.get('error')}")
sys.exit("Root channel server never said hello to the Router")
PY
then
    echo "Root launch failed; cleaning up" >&2
    tmux kill-session -t "=root_agent" 2>/dev/null
    python3 -c 'import sys; from pathlib import Path; [Path(p).unlink(missing_ok=True) for p in sys.argv[1:]]' \
        "$ROOT_KEY_FILE" "$ROOT_READY_FILE"
    exit 1
fi

echo "Restarted root agent in tmux session 'root_agent'"
echo "Attach with: tmux attach -t root_agent"
