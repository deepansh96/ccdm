#!/bin/bash
# Shared function: updates bot Discord nickname with context window usage.
# Sourced by cc-discord-nicknames.sh and cc-statusline-wrapper.sh.

# Router sessions (launched with CCDM_ROUTER_KEY_FILE) never PATCH a nickname:
# the latest context percentage goes to a private file in the launch
# directory, and the CCDM channel server sends it with each reply.
write_router_context() {
  local input="$1"
  local key_file="$CCDM_ROUTER_KEY_FILE"
  local project router_state launch_dir pct tmp
  project="$(basename "$key_file" .key)"
  router_state="$(dirname "$(dirname "$key_file")")"
  launch_dir="$router_state/launches/$project"
  pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)
  [[ "$pct" =~ ^[0-9]+(\.[0-9]+)?$ ]] && [ -d "$launch_dir" ] || return 0
  tmp="$launch_dir/.context.json.$$.tmp"
  (umask 077 && printf '{"context_pct": %s}\n' "$pct" > "$tmp") && mv -f "$tmp" "$launch_dir/context.json"
}

update_discord_nickname() {
  local input="$1"
  local interval="${CONTEXT_DISCORD_INTERVAL:-60}"

  if [ -n "${CCDM_ROUTER_KEY_FILE:-}" ]; then
    write_router_context "$input"
    return 0
  fi

  if [ -n "$DISCORD_STATE_DIR" ] && [ "${DISABLE_DISCORD_MESSAGE:-false}" != "true" ]; then
    (
      CONTEXT_PCT=$(echo "$input" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)
      if [ -n "$CONTEXT_PCT" ]; then
        STATE_NAME=$(basename "$DISCORD_STATE_DIR")
        LAST_SENT_FILE="/tmp/cc-context-${STATE_NAME}"
        NOW=$(date +%s)
        LAST_SENT=$(cat "$LAST_SENT_FILE" 2>/dev/null || echo 0)
        if [ $((NOW - LAST_SENT)) -ge "$interval" ]; then
          BOT_TOKEN=$(grep DISCORD_BOT_TOKEN "$DISCORD_STATE_DIR/.env" | cut -d= -f2)
          REGISTRY="$(cd "$(dirname "$0")/.." && pwd)/registry.json"
          GUILD_ID=$(jq -r '.guild_id' "$REGISTRY")
          ROOT_TOKEN=$(grep DISCORD_BOT_TOKEN ~/.claude/channels/discord/.env | cut -d= -f2)
          BOT_APP_ID=$(jq -r ".pool[] | select(.state_dir | endswith(\"$STATE_NAME\")) | .app_id" "$REGISTRY")
          BOT_ID=$(jq -r ".pool[] | select(.state_dir | endswith(\"$STATE_NAME\")) | .id" "$REGISTRY")
          PROJECT=$(jq -r ".pool[] | select(.state_dir | endswith(\"$STATE_NAME\")) | .assigned_to" "$REGISTRY")
          SESSION_TYPE=$(jq -r ".projects[\"$PROJECT\"].type // \"claude\"" "$REGISTRY")

          if [ -n "$BOT_APP_ID" ] && [ "$BOT_APP_ID" != "null" ]; then
            NICK="${BOT_ID}-${PROJECT}-${SESSION_TYPE} · ${CONTEXT_PCT}%"
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
}
