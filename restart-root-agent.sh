#!/bin/zsh
# Restart the root agent Discord bot
# Run this from any terminal — it kills the current instance and starts a new one in tmux

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Stop any existing root_agent tmux session
tmux kill-session -t root_agent 2>/dev/null

# Kill only root agent processes (state dir is "channels/discord " with no number suffix)
# Other bots use discord2, discord3, etc. — the pattern matches "discord " followed by "claude"
# but NOT "discord2", "discord3", etc.
pgrep -f 'channels/discord claude' | xargs kill 2>/dev/null

sleep 2

# Start fresh in a detached tmux session
tmux new-session -d -s root_agent -- zsh -ic "cd $SCRIPT_DIR && DISCORD_STATE_DIR=~/.claude/channels/discord claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions"

# Dismiss the trust dialog
sleep 8 && tmux send-keys -t root_agent Enter

echo "Restarted root agent in tmux session 'root_agent'"
echo "Attach with: tmux attach -t root_agent"
