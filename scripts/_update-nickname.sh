#!/bin/bash
# Shared function: records a Claude session's context window usage.
# Sourced by cc-discord-nicknames.sh and cc-statusline-wrapper.sh.

# Every Claude session is a Router session (launched with CCDM_ROUTER_KEY_FILE)
# and no session PATCHes a nickname: the latest context percentage goes to a
# private file in the launch directory, and the CCDM channel server sends it
# with each reply.
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

  if [ -n "${CCDM_ROUTER_KEY_FILE:-}" ]; then
    write_router_context "$input"
  fi
  return 0
}
