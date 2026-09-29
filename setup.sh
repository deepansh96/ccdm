#!/bin/zsh
# CCDM — Claude Code Discord Manager
# Interactive first-run setup script

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  CCDM — Claude Code Discord Manager Setup   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Check prerequisites ──
echo "Checking prerequisites..."
missing=()

if ! command -v claude &>/dev/null; then
    missing+=("claude (Claude Code CLI — install from https://docs.anthropic.com/en/docs/claude-code)")
fi
if ! command -v tmux &>/dev/null; then
    missing+=("tmux (brew install tmux / apt install tmux)")
fi
if ! command -v zsh &>/dev/null; then
    missing+=("zsh (brew install zsh / apt install zsh)")
fi
if ! command -v python3 &>/dev/null; then
    missing+=("python3 (brew install python3 / apt install python3)")
fi
if ! command -v jq &>/dev/null; then
    missing+=("jq (brew install jq / apt install jq)")
fi

if [ ${#missing[@]} -gt 0 ]; then
    echo ""
    echo "Missing required tools:"
    for m in "${missing[@]}"; do
        echo "  - $m"
    done
    echo ""
    echo "Install them and re-run this script."
    exit 1
fi

echo "  All prerequisites found."
echo ""

# ── Optional: check for whisper ──
if ! command -v whisper &>/dev/null; then
    echo "Note: whisper not found. Voice message transcription won't work."
    echo "  Install with: pip install openai-whisper"
    echo ""
fi

# ── Get Discord user ID ──
echo "To find your Discord user ID:"
echo "  1. Open Discord Settings > Advanced > enable Developer Mode"
echo "  2. Right-click your name in any chat > Copy User ID"
echo ""
read "discord_id?Enter your Discord user ID: "

if [ -z "$discord_id" ]; then
    echo "Error: Discord user ID is required."
    exit 1
fi

# ── Get Discord server (guild) ID ──
echo "To find your Discord server ID:"
echo "  1. Make sure Developer Mode is enabled (Settings > Advanced)"
echo "  2. Right-click the server name > Copy Server ID"
echo ""
read "guild_id?Enter your Discord server ID: "

if [ -z "$guild_id" ]; then
    echo "Error: Discord server ID is required."
    exit 1
fi

# ── Create registry.json ──
REGISTRY_CONTENT="{
  \"discord_user_id\": \"$discord_id\",
  \"guild_id\": \"$guild_id\",
  \"root_channels\": [],
  \"root_allowed_user_ids\": [],
  \"codex_accounts\": {},
  \"default_codex_account\": null,
  \"category_ids\": [],
  \"projects\": {}
}"

if [ -f "$SCRIPT_DIR/registry.json" ]; then
    echo ""
    echo "registry.json already exists. Overwrite? (y/N)"
    read "overwrite?"
    if [[ "$overwrite" != [yY] ]]; then
        echo "Keeping existing registry.json."
    else
        echo "$REGISTRY_CONTENT" > "$SCRIPT_DIR/registry.json"
        echo "Created registry.json."
    fi
else
    echo "$REGISTRY_CONTENT" > "$SCRIPT_DIR/registry.json"
    echo "Created registry.json."
fi

# ── Get bot token ──
echo ""
echo "CCDM uses one Discord bot, root. The Router holds its token and serves"
echo "root and every project channel through it."
echo "If you don't have the bot yet, create it at https://discord.com/developers/applications"
echo "(See README.md for detailed instructions)"
echo ""
read "bot_token?Enter the root bot's Discord bot token: "

if [ -z "$bot_token" ]; then
    echo "Error: Bot token is required."
    exit 1
fi

# ── Determine state directory ──
STATE_BASE="$HOME/.claude/channels"
STATE_DIR="$STATE_BASE/discord"

# Check if the default directory is already in use
if [ -f "$STATE_DIR/.env" ]; then
    echo ""
    echo "Warning: $STATE_DIR already has a .env file."
    echo "This may be used by another bot. Overwrite? (y/N)"
    read "overwrite_state?"
    if [[ "$overwrite_state" != [yY] ]]; then
        # Find next available number
        n=2
        while [ -d "$STATE_BASE/discord${n}" ]; do
            ((n++))
        done
        STATE_DIR="$STATE_BASE/discord${n}"
        echo "Using $STATE_DIR instead."
    fi
fi

# ── Create state directory ──
mkdir -p "$STATE_DIR"

# Write .env: the only place the root bot token lives. The Router and root's
# admin scripts read it from here.
echo "DISCORD_BOT_TOKEN=$bot_token" > "$STATE_DIR/.env"
echo "Created $STATE_DIR/.env"

# ── Make scripts executable ──
chmod +x "$SCRIPT_DIR/restart-root-agent.sh"
chmod +x "$SCRIPT_DIR/scripts/claude-usage.sh"

echo ""
echo "════════════════════════════════════════════════"
echo "  Setup complete!"
echo "════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo ""
echo "  1. Create a root channel in your server and add its ID to \"root_channels\""
echo "     in $SCRIPT_DIR/registry.json. Add anyone else who may talk to root"
echo "     to \"root_allowed_user_ids\"."
echo "  2. Install and start the Router (it holds the root bot token):"
echo "       $SCRIPT_DIR/scripts/install-router-service.sh"
echo "       node $SCRIPT_DIR/scripts/router.js status"
echo "  3. Start the root agent as a Router client:"
echo "       $SCRIPT_DIR/restart-root-agent.sh"
echo ""
echo "Then message root in your root channel to register and manage projects."
echo "Each project gets its own channel and webhook; no extra bots are needed."
echo ""
echo "Useful commands:"
echo "  tmux attach -t root_agent   # Attach to the session"
echo "  tmux list-sessions          # List active sessions"
echo "  Ctrl+B, D                   # Detach from a session"
echo ""
