#!/bin/bash
# Updates bot Discord nicknames with context window usage (e.g. "bot4-quiz · 42%").
# Set as the statusLine command in ~/.claude/settings.json.
# Requires: DISCORD_STATE_DIR env var (set automatically for Discord sessions).
# Use cc-statusline-wrapper.sh instead if you also want the ccstatusline terminal UI.

INTERVAL="${CONTEXT_DISCORD_INTERVAL:-60}"

INPUT=$(cat)

if [ -n "$DISCORD_STATE_DIR" ] && [ "${DISABLE_DISCORD_MESSAGE:-false}" != "true" ]; then
  (
    CONTEXT_PCT=$(echo "$INPUT" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)
    if [ -n "$CONTEXT_PCT" ]; then
      STATE_NAME=$(basename "$DISCORD_STATE_DIR")
      LAST_SENT_FILE="/tmp/cc-context-${STATE_NAME}"
      NOW=$(date +%s)
      LAST_SENT=$(cat "$LAST_SENT_FILE" 2>/dev/null || echo 0)
      if [ $((NOW - LAST_SENT)) -ge "$INTERVAL" ]; then
        BOT_TOKEN=$(grep DISCORD_BOT_TOKEN "$DISCORD_STATE_DIR/.env" | cut -d= -f2)
        REGISTRY="$(cd "$(dirname "$0")/.." && pwd)/registry.json"
        GUILD_ID=$(jq -r '.guild_id' "$REGISTRY")
        ROOT_TOKEN=$(grep DISCORD_BOT_TOKEN ~/.claude/channels/discord/.env | cut -d= -f2)
        BOT_APP_ID=$(jq -r ".pool[] | select(.state_dir | endswith(\"$STATE_NAME\")) | .app_id" "$REGISTRY")
        BOT_ID=$(jq -r ".pool[] | select(.state_dir | endswith(\"$STATE_NAME\")) | .id" "$REGISTRY")
        PROJECT=$(jq -r ".pool[] | select(.state_dir | endswith(\"$STATE_NAME\")) | .assigned_to" "$REGISTRY")

        if [ -n "$BOT_APP_ID" ] && [ "$BOT_APP_ID" != "null" ]; then
          NICK="${BOT_ID}-${PROJECT} · ${CONTEXT_PCT}%"
          curl -s -X PATCH "https://discord.com/api/v10/guilds/$GUILD_ID/members/$BOT_APP_ID" \
            -H "Authorization: Bot $ROOT_TOKEN" \
            -H "Content-Type: application/json" \
            -d "{\"nick\": \"$NICK\"}" > /dev/null 2>&1
        else
          curl -s -X PATCH "https://discord.com/api/v10/guilds/$GUILD_ID/members/@me" \
            -H "Authorization: Bot $BOT_TOKEN" \
            -H "Content-Type: application/json" \
            -d "{\"nick\": \"root · ${CONTEXT_PCT}%\"}" > /dev/null 2>&1
        fi

        echo "$NOW" > "$LAST_SENT_FILE"
      fi
    fi
  ) &
fi

echo "$INPUT"
