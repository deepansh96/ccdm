#!/bin/zsh
# Restart the root agent Discord bot
# Run this from any terminal — it kills the current instance and starts a new one in screen

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Stop any existing root_agent screen session
screen -X -S root_agent quit 2>/dev/null

# Kill only root agent processes (state dir is "channels/discord " with no number suffix)
# Other bots use discord2, discord3, etc. — the pattern matches "discord " followed by "claude"
# but NOT "discord2", "discord3", etc.
pgrep -f 'channels/discord claude' | xargs kill 2>/dev/null

sleep 2

# Start fresh in a detached screen session
screen -dmS root_agent expect -c "
spawn zsh -ic {cd $SCRIPT_DIR && DISCORD_STATE_DIR=~/.claude/channels/discord claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions}
expect \"Enter to confirm\"
send \"\\r\"
interact
"

echo "Restarted root agent in screen session 'root_agent'"
echo "Attach with: screen -r root_agent"
