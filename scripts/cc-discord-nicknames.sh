#!/bin/bash
# Updates bot Discord nicknames with context window usage (e.g. "bot4-quiz · 42%").
# Set as the statusLine command in ~/.claude/settings.json.
# Requires: DISCORD_STATE_DIR env var (set automatically for Discord sessions).
# Use cc-statusline-wrapper.sh instead if you also want the ccstatusline terminal UI.

source "$(dirname "$0")/_update-nickname.sh"

INPUT=$(cat)
update_discord_nickname "$INPUT"
echo "$INPUT"
