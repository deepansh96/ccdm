#!/bin/zsh
# Restart the root agent Discord bot
# Run this from any terminal — it kills the current instance and starts a new one in tmux

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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
tmux new-session -d -s root_agent -- zsh -ic "cd $SCRIPT_DIR && DISCORD_STATE_DIR=~/.claude/channels/discord claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions"

if [ $? -ne 0 ]; then
    echo "Failed to create tmux session 'root_agent'" >&2
    exit 1
fi

# Dismiss the trust dialog
sleep 8 && tmux send-keys -t root_agent Enter

echo "Restarted root agent in tmux session 'root_agent'"
echo "Attach with: tmux attach -t root_agent"
