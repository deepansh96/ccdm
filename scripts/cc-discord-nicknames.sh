#!/bin/bash
# Records a Router session's context window usage, which its replies carry.
# It never PATCHes a Discord nickname.
# Set as the statusLine command in ~/.claude/settings.json.
# Uses CCDM_ROUTER_KEY_FILE (set automatically for CCDM Claude sessions).
# Use cc-statusline-wrapper.sh instead if you also want the ccstatusline terminal UI.

source "$(dirname "$0")/_update-nickname.sh"

INPUT=$(cat)
update_discord_nickname "$INPUT"
echo "$INPUT"
