#!/bin/bash
# Wraps ccstatusline to also update bot nickname with context % periodically.
# Set as the statusLine command in ~/.claude/settings.json.
# Requires: DISCORD_STATE_DIR env var (set automatically for Discord sessions).

source "$(dirname "$0")/_update-nickname.sh"

INPUT=$(cat)
update_discord_nickname "$INPUT"
echo "$INPUT" | npx -y ccstatusline@latest
