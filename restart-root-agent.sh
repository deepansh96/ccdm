#!/bin/zsh
# Restart the root agent Discord bot
# Run this from any terminal — it kills the current instance and starts a new one in tmux

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANNEL_ARGS="--channels plugin:discord@claude-plugins-official"
ROOT_STATE_ASSIGNMENT="DISCORD_STATE_DIR=~/.claude/channels/discord"
if [[ "${CCDM_CLAUDE_REMINDER_ADAPTER:-0}" == "1" ]]; then
    ROOT_STATE_DIR="${ROOT_DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}"
    ROOT_STATE_ASSIGNMENT="DISCORD_STATE_DIR='$ROOT_STATE_DIR'"
    ROOT_MCP_CONFIG="$ROOT_STATE_DIR/ccdm-root-reminder-mcp.json"
    ROOT_REMINDER_SETTINGS="$ROOT_STATE_DIR/ccdm-root-reminder-settings.json"
    python3 - "$SCRIPT_DIR" "$ROOT_STATE_DIR" "$ROOT_MCP_CONFIG" "$ROOT_REMINDER_SETTINGS" <<'PY'
import json
import os
import base64
import re
import subprocess
from pathlib import Path
import sys

root, state_dir, config_path, settings_path = map(Path, sys.argv[1:5])
version = subprocess.run(["claude", "--version"], capture_output=True, text=True)
if version.returncode != 0 or not re.match(r"^2\.1\.281(?:\s|$)", version.stdout.strip()):
    sys.exit("Root Claude reminder adapter: unsupported Claude Code version (tested: 2.1.281)")
registry = json.loads((root / "registry.json").read_text())
root_app_id = registry.get("root_bot_app_id") or os.environ.get("ROOT_BOT_APP_ID")
root_env = state_dir / ".env"
if root_env.is_file():
    match = re.search(r"^DISCORD_BOT_TOKEN=(\S+)", root_env.read_text(), re.MULTILINE)
    if match:
        encoded_id = match.group(1).split(".")[0]
        try:
            root_app_id = base64.urlsafe_b64decode(encoded_id + "=" * (-len(encoded_id) % 4)).decode("ascii")
        except (ValueError, UnicodeDecodeError):
            pass
if not root_app_id:
    sys.exit("Root Claude reminder adapter requires root bot identity")
plugin_dir = Path.home() / ".claude" / "plugins" / "cache" / "claude-plugins-official" / "discord" / "0.0.4"
if not (plugin_dir / "server.ts").is_file():
    sys.exit("Root Claude reminder adapter requires installed official Discord plugin 0.0.4")
reminder_dir = Path(os.environ.get("CCDM_REMINDER_STATE_DIR") or Path.home() / ".local" / "state" / "ccdm" / "conversation-reminders")
state_dir.mkdir(parents=True, exist_ok=True)
config = {"mcpServers": {"discord": {
    "command": "node",
    "args": [str(root / "scripts" / "claude-reminder-channel.js")],
    "env": {
        "DISCORD_STATE_DIR": str(state_dir),
        "CCDM_REMINDER_PROJECT_ROOT": str(root),
        "CCDM_REMINDER_STATE_DIR": str(reminder_dir),
        "CCDM_CLAUDE_ROOT_APP_ID": str(root_app_id),
        "CCDM_CLAUDE_PLUGIN_ROOT": str(plugin_dir),
    },
}}}
config_path.write_text(json.dumps(config, indent=2) + "\n")
os.chmod(config_path, 0o600)
settings_path.write_text(json.dumps({"enabledPlugins": {"discord@claude-plugins-official": False}}, indent=2) + "\n")
os.chmod(settings_path, 0o600)
PY
    if [[ $? -ne 0 ]]; then
        echo "Root Claude reminder adapter preflight failed" >&2
        exit 1
    fi
    CHANNEL_ARGS="--dangerously-load-development-channels server:discord --mcp-config '$ROOT_MCP_CONFIG' --settings '$ROOT_REMINDER_SETTINGS'"
fi

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
tmux new-session -d -s root_agent -- zsh -ic "cd $SCRIPT_DIR && $ROOT_STATE_ASSIGNMENT claude $CHANNEL_ARGS --dangerously-skip-permissions"

if [ $? -ne 0 ]; then
    echo "Failed to create tmux session 'root_agent'" >&2
    exit 1
fi

# Dismiss the trust dialog
sleep 8 && tmux send-keys -t root_agent Enter

echo "Restarted root agent in tmux session 'root_agent'"
echo "Attach with: tmux attach -t root_agent"
