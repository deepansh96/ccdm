#!/bin/bash
# Wraps ccstatusline to also update bot nickname with context % periodically.
# Set as the statusLine command in ~/.claude/settings.json.
# Requires: DISCORD_STATE_DIR env var (set automatically for Discord sessions).

# Ensure Homebrew + node@22 bins are on PATH; the statusLine command may run
# with a minimal environment that lacks them.
if [[ -z "${CCDM_TEST_STATE:-}" ]]; then
  export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:$PATH"
fi

source "$(dirname "$0")/_update-nickname.sh"

INPUT=$(cat)
update_discord_nickname "$INPUT"

# Prefer a globally installed binary (instant, no network). Fall back to npx
# only if it's missing. Using `npx -y ...@latest` on every render triggers a
# registry check and concurrent renders can corrupt the npx cache.
if command -v ccstatusline >/dev/null 2>&1; then
  echo "$INPUT" | ccstatusline
else
  echo "$INPUT" | npx -y ccstatusline@latest
fi
